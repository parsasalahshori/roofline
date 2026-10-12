import pg from 'pg';
import { normalizeAddressKey } from '@roofline/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { upsertCompanyStorm } from '../src/repos/company-storms.ts';
import { countStormRequestsSince, createStormRequest, type StormRequestInput } from '../src/repos/storm-requests.ts';
import { ensureStormPage } from '../src/repos/storm-pages.ts';
import { createPools, type Pools } from '../src/pools.ts';
import { type TenantContext, type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { insertOmahaStorm, type Query } from './fixtures/storms.ts';

const urls = inject('dbUrls');

let owner: pg.Pool;
let pools: Pools;
let seed: { a: SeededCompany; b: SeededCompany };

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

const NOW = new Date('2026-05-02T12:00:00Z');
const CONSENT = 'Yes, text me about my storm inspection. Msg and data rates may apply. Reply STOP to opt out.';
const PHONE = '+14025550111';

function ctxOf(company: SeededCompany): TenantContext {
  return { companyId: company.companyId, userId: null, role: 'system', canApproveSpend: false };
}

const asCompany = <T>(company: SeededCompany, fn: (tx: Tx) => Promise<T>) => withTenant(pools, ctxOf(company), fn);

/** Makes the company's storm row and its landing page for one storm day; returns the page id and the storm id. */
async function pageFor(company: SeededCompany, convectiveDay: string): Promise<{ pageId: string; stormId: string }> {
  const stormId = await insertOmahaStorm(q, convectiveDay);
  const pageId = await asCompany(company, async (tx) => {
    const { companyStorm } = await upsertCompanyStorm(tx, { stormId, maxIn: 1.5, customersHit: 0, homesHit: 0, now: NOW });
    const page = await ensureStormPage(tx, ctxOf(company), { companyStormId: companyStorm.id, now: NOW });
    return page.id;
  });
  return { pageId, stormId };
}

function requestInput(pageId: string, overrides: Partial<StormRequestInput> = {}): StormRequestInput {
  return {
    stormPageId: pageId,
    name: 'Pat Homeowner',
    phoneE164: PHONE,
    address: '101 Maple St, Omaha, NE 68102',
    property: {
      addressLine: '101 Maple St',
      city: 'Omaha',
      state: 'NE',
      zip: '68102',
      location: [-95.925, 41.25],
      timezone: 'America/Chicago',
    },
    okToText: false,
    consentText: CONSENT,
    ipHash: 'ip-hash-1',
    now: NOW,
    ...overrides,
  };
}

const create = (company: SeededCompany, input: StormRequestInput) => asCompany(company, (tx) => createStormRequest(tx, ctxOf(company), input));

async function rowsOf(companyId: string, table: string) {
  return q(`select * from ${table} where company_id = $1`, [companyId]);
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: urls.owner });
  pools = createPools({ tenant: urls.tenant, system: urls.system });
});

afterAll(async () => {
  await pools?.end();
  await owner?.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('createStormRequest', () => {
  test('a new request makes one web customer, one address, one lead job and one linked request', async () => {
    const { pageId, stormId } = await pageFor(seed.a, '2026-05-01');
    const result = await create(seed.a, requestInput(pageId));
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    const customers = await rowsOf(seed.a.companyId, 'customers');
    expect(customers).toHaveLength(1);
    expect(customers[0]!.source).toBe('web');
    expect(customers[0]!.display_name).toBe('Pat Homeowner');
    expect(customers[0]!.phones).toEqual([{ e164: PHONE, primary: true }]);
    expect(result.customerId).toBe(customers[0]!.id);

    const properties = await rowsOf(seed.a.companyId, 'properties');
    expect(properties).toHaveLength(1);
    expect(properties[0]!.customer_id).toBe(customers[0]!.id);

    const jobs = await rowsOf(seed.a.companyId, 'jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(result.jobId);
    expect(jobs[0]!.stage).toBe('lead');
    expect(jobs[0]!.source).toBe('web');
    expect(jobs[0]!.storm_id).toBe(stormId);
    expect(jobs[0]!.customer_id).toBe(customers[0]!.id);
    expect(jobs[0]!.property_id).toBe(properties[0]!.id);
    expect(new Date(jobs[0]!.next_step_on as Date).toISOString().slice(0, 10)).toBe('2026-05-02');
    expect(jobs[0]!.next_step).toBeTruthy();

    const requests = await rowsOf(seed.a.companyId, 'storm_requests');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe(result.requestId);
    expect(requests[0]!.customer_id).toBe(customers[0]!.id);
    expect(requests[0]!.job_id).toBe(result.jobId);
    expect(requests[0]!.storm_page_id).toBe(pageId);
    expect(requests[0]!.ip_hash).toBe('ip-hash-1');
  });

  test('the landing-page lead has the normal job audit row and timeline lines, with no signed-in actor', async () => {
    const { pageId, stormId } = await pageFor(seed.a, '2026-05-01');
    const result = await create(seed.a, requestInput(pageId));
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    const audits = await q(`select * from audit_log where company_id = $1 and target_type = 'job' and target_id = $2`, [seed.a.companyId, result.jobId]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'job.create', actor_user_id: null });
    expect(audits[0]!.after).toMatchObject({ source: 'web', stage: 'lead', customerId: result.customerId });

    const jobLines = await q(
      `select kind, summary, actor_type, actor_user_id from activities where company_id = $1 and subject_type = 'job' and subject_id = $2 order by id`,
      [seed.a.companyId, result.jobId],
    );
    const summaries = jobLines.map((r) => r.summary as string);
    expect(summaries).toContain('Job created');
    expect(summaries).toContain('Storm inspection request from the storm page');
    expect(summaries.some((x) => x.startsWith('Next step: '))).toBe(true);
    for (const line of jobLines) expect(line).toMatchObject({ actor_type: 'system', actor_user_id: null });

    const customerLines = await q(
      `select summary from activities where company_id = $1 and subject_type = 'customer' and subject_id = $2 and kind = 'job.created'`,
      [seed.a.companyId, result.customerId],
    );
    expect(customerLines.map((r) => r.summary)).toEqual(['New job: 101 Maple St']);
    const [job] = await rowsOf(seed.a.companyId, 'jobs');
    expect(job!.storm_id).toBe(stormId);
    expect(job!.created_by_user_id).toBeNull();
  });

  test('an address that is another customer\'s home attaches the lead to them, and the job line says it came from the storm page', async () => {
    const [owner] = await q(
      `insert into customers (company_id, display_name, phones, source) values ($1, 'Home Owner', $2::jsonb, 'manual') returning id`,
      [seed.a.companyId, JSON.stringify([{ e164: '+14025550999', primary: true }])],
    );
    await q(
      `insert into properties (company_id, customer_id, address_line, city, state, zip, address_key) values ($1, $2, '101 Maple St', 'Omaha', 'NE', '68102', $3)`,
      [seed.a.companyId, owner!.id, normalizeAddressKey('101 Maple St', '68102')],
    );
    const { pageId } = await pageFor(seed.a, '2026-05-01');

    const result = await create(seed.a, requestInput(pageId));
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.customerId).toBe(owner!.id);

    const lines = await q(
      `select summary, data from activities where company_id = $1 and subject_type = 'job' and subject_id = $2 and summary like 'Storm inspection request%'`,
      [seed.a.companyId, result.jobId],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.summary).toBe('Storm inspection request from the storm page, sent for this home by Pat Homeowner');
    expect(lines[0]!.data).toMatchObject({ requestedByCustomerId: expect.any(String) });
  });

  test('okToText false leaves consent at none with no evidence', async () => {
    const { pageId } = await pageFor(seed.a, '2026-05-01');
    await create(seed.a, requestInput(pageId, { okToText: false }));

    const [customer] = await rowsOf(seed.a.companyId, 'customers');
    expect(customer!.sms_consent_status).toBe('none');
    expect(customer!.sms_consent_source).toBeNull();
    expect(customer!.sms_consent_evidence).toBeNull();

    const [request] = await rowsOf(seed.a.companyId, 'storm_requests');
    expect(request!.sms_consent).toBe(false);
    expect(request!.consent_text).toBeNull();
    expect(request!.consent_at).toBeNull();
  });

  test('okToText true records express consent from the web form with the exact consent text as evidence', async () => {
    const { pageId } = await pageFor(seed.a, '2026-05-01');
    await create(seed.a, requestInput(pageId, { okToText: true }));

    const [customer] = await rowsOf(seed.a.companyId, 'customers');
    expect(customer!.sms_consent_status).toBe('express');
    expect(customer!.sms_consent_source).toBe('web_form');
    expect(customer!.sms_consent_at).not.toBeNull();
    expect((customer!.sms_consent_evidence as { consentText: string }).consentText).toBe(CONSENT);
    expect((customer!.sms_consent_evidence as { source: string }).source).toBe('web_form');

    const [request] = await rowsOf(seed.a.companyId, 'storm_requests');
    expect(request!.sms_consent).toBe(true);
    expect(request!.consent_text).toBe(CONSENT);
    expect(request!.consent_at).not.toBeNull();
  });

  test('the same phone on the same page is a duplicate with no second job', async () => {
    const { pageId } = await pageFor(seed.a, '2026-05-01');
    const first = await create(seed.a, requestInput(pageId));
    expect(first.status).toBe('created');

    const second = await create(seed.a, requestInput(pageId, { name: 'Someone Else', okToText: true }));
    expect(second).toEqual({ status: 'duplicate' });

    expect(await rowsOf(seed.a.companyId, 'jobs')).toHaveLength(1);
    expect(await rowsOf(seed.a.companyId, 'customers')).toHaveLength(1);
    expect(await rowsOf(seed.a.companyId, 'storm_requests')).toHaveLength(1);
  });

  test('the same phone on a different page creates a new request and job', async () => {
    const first = await pageFor(seed.a, '2026-05-01');
    const second = await pageFor(seed.a, '2026-05-04');
    expect(second.pageId).not.toBe(first.pageId);

    await create(seed.a, requestInput(first.pageId));
    const again = await create(seed.a, requestInput(second.pageId, { address: '202 Oak Ave, Omaha, NE 68102', property: { addressLine: '202 Oak Ave', city: 'Omaha', state: 'NE', zip: '68102', location: null, timezone: null } }));
    expect(again.status).toBe('created');

    expect(await rowsOf(seed.a.companyId, 'storm_requests')).toHaveLength(2);
    expect(await rowsOf(seed.a.companyId, 'jobs')).toHaveLength(2);
  });

  test('an existing customer with that phone is reused, not duplicated', async () => {
    const existing = await q(
      `insert into customers (company_id, display_name, phones, source, sms_consent_status)
       values ($1, 'Pat Existing', $2::jsonb, 'manual', 'none') returning id`,
      [seed.a.companyId, JSON.stringify([{ e164: PHONE, primary: true }])],
    );
    const { pageId } = await pageFor(seed.a, '2026-05-01');

    const result = await create(seed.a, requestInput(pageId));
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    const customers = await rowsOf(seed.a.companyId, 'customers');
    expect(customers).toHaveLength(1);
    expect(customers[0]!.id).toBe(existing[0]!.id);
    expect(result.customerId).toBe(existing[0]!.id);
  });

  test('a revoked customer stays revoked even when the box is ticked', async () => {
    await q(
      `insert into customers (company_id, display_name, phones, source, sms_consent_status, sms_consent_source)
       values ($1, 'Pat Revoked', $2::jsonb, 'manual', 'revoked', 'manual')`,
      [seed.a.companyId, JSON.stringify([{ e164: PHONE, primary: true }])],
    );
    const { pageId } = await pageFor(seed.a, '2026-05-01');

    const result = await create(seed.a, requestInput(pageId, { okToText: true }));
    expect(result.status).toBe('created');

    const [customer] = await rowsOf(seed.a.companyId, 'customers');
    expect(customer!.sms_consent_status).toBe('revoked');
    expect(customer!.sms_consent_source).toBe('manual');
  });

  test('a do-not-contact customer keeps do-not-contact even when the box is ticked', async () => {
    await q(
      `insert into customers (company_id, display_name, phones, source, do_not_contact)
       values ($1, 'Pat Blocked', $2::jsonb, 'manual', true)`,
      [seed.a.companyId, JSON.stringify([{ e164: PHONE, primary: true }])],
    );
    const { pageId } = await pageFor(seed.a, '2026-05-01');

    await create(seed.a, requestInput(pageId, { okToText: true }));

    const [customer] = await rowsOf(seed.a.companyId, 'customers');
    expect(customer!.do_not_contact).toBe(true);
    expect(customer!.sms_consent_status).toBe('none');
  });

  test('a page of another company cannot be used', async () => {
    const { pageId } = await pageFor(seed.a, '2026-05-01');
    await expect(create(seed.b, requestInput(pageId))).rejects.toThrow();
    expect(await rowsOf(seed.a.companyId, 'storm_requests')).toHaveLength(0);
    expect(await rowsOf(seed.b.companyId, 'customers')).toHaveLength(0);
  });
});

describe('countStormRequestsSince', () => {
  test('counts only the requests made at or after the cutoff', async () => {
    const { pageId } = await pageFor(seed.a, '2026-05-01');
    const times = ['2026-05-02T10:00:00Z', '2026-05-02T12:00:00Z', '2026-05-02T14:00:00Z'];
    for (const [i, at] of times.entries()) {
      const phone = `+1402555020${i}`;
      const result = await create(
        seed.a,
        requestInput(pageId, { phoneE164: phone, name: `Pat ${i}`, address: `${300 + i} Elm St`, property: { addressLine: `${300 + i} Elm St`, city: 'Omaha', state: 'NE', zip: '68102', location: null, timezone: null }, now: new Date(at) }),
      );
      expect(result.status).toBe('created');
    }

    const since = new Date('2026-05-02T12:00:00Z');
    expect(await asCompany(seed.a, (tx) => countStormRequestsSince(tx, ctxOf(seed.a), pageId, since))).toBe(2);
    expect(await asCompany(seed.a, (tx) => countStormRequestsSince(tx, ctxOf(seed.a), pageId, new Date('2026-05-03T00:00:00Z')))).toBe(0);
  });

  test('company B sees none of company A requests', async () => {
    const { pageId } = await pageFor(seed.a, '2026-05-01');
    await create(seed.a, requestInput(pageId));
    const seenByB = await asCompany(seed.b, (tx) => countStormRequestsSince(tx, ctxOf(seed.b), pageId, new Date('2000-01-01T00:00:00Z')));
    expect(seenByB).toBe(0);
  });
});

describe('isolation', () => {
  test('company B requests and customers stay separate from company A', async () => {
    const pageA = await pageFor(seed.a, '2026-05-01');
    const pageB = await pageFor(seed.b, '2026-05-01');
    await create(seed.a, requestInput(pageA.pageId));
    await create(seed.b, requestInput(pageB.pageId));

    expect(await rowsOf(seed.a.companyId, 'customers')).toHaveLength(1);
    expect(await rowsOf(seed.b.companyId, 'customers')).toHaveLength(1);
    expect(await rowsOf(seed.b.companyId, 'jobs')).toHaveLength(1);
    expect((await rowsOf(seed.a.companyId, 'jobs'))[0]!.company_id).toBe(seed.a.companyId);
  });
});
