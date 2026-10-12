import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { textingCompanyFacts, withTenant } from '@roofline/db';
import { buildCampaign, plainRejection } from '@roofline/shared';
import { advanceRegistration } from '../src/account/texting/advance.ts';
import { systemContext } from '../src/permissions.ts';
import { policyUrls } from '../src/public/policy-urls.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

const BRAND = {
  legalName: 'Acme Roofing LLC',
  ein: '12-3456789',
  businessType: 'llc',
  street: '1200 Farnam St',
  city: 'Omaha',
  state: 'NE',
  zip: '68102',
  website: 'https://acme.com',
  contactFirstName: 'Maria',
  contactLastName: 'Lopez',
  contactEmail: 'maria@acme.test',
  contactPhone: '(402) 555-0199',
  contactTitle: 'Owner',
};

const CAMPAIGN_FEE_DESCRIPTION = 'Texting registration: carrier review';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  // The seed gives every company an approved registration row. These tests start from none.
  await ownerQuery('delete from texting_registrations where company_id = $1', [t.seed.a.companyId]);
});

afterEach(async () => {
  await t.close();
});

/** Runs SQL as the owner role, which bypasses row-level security. */
async function ownerQuery<R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    const res = await client.query<R>(sql, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

/** Gives Acme a card: a subscription, and the given company status (active unless a test says otherwise). */
async function addCard(status = 'active'): Promise<void> {
  await ownerQuery('update companies set stripe_subscription_id = $2, status = $3 where id = $1', [
    t.seed.a.companyId,
    'sub_test',
    status,
  ]);
}

/** The owner submits the brand, then the texting-registration job runs (stage 1 and the stages after it). */
async function submitAndDrain(): Promise<void> {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const res = await owner.post('/api/texting/registration').send({ brand: BRAND, useHostedPolicyPages: false });
  expect(res.status).toBe(202);
  await t.jobs.drain(t.deps);
}

/** The arguments of the first registrar call named `method`. */
function firstCall(method: string): unknown[] {
  const call = t.registrar.calls.find((c) => c.method === method);
  if (!call) throw new Error(`no ${method} call`);
  return call.args;
}

function callsOf(method: string): { method: string; args: unknown[] }[] {
  return t.registrar.calls.filter((c) => c.method === method);
}

describe('texting registration progress', () => {
  test("brand approved → campaign submitted with the company's details, fee once", async () => {
    const companyId = t.seed.a.companyId;
    const base = t.deps.config.PUBLIC_BASE_URL;
    t.registrar.setBrand('approved');
    await addCard();

    await submitAndDrain();
    await advanceRegistration(t.deps, companyId);

    expect(firstCall('ensureMessagingService')[2]).toEqual({
      inbound: `${base}/hooks/twilio/sms`,
      status: `${base}/hooks/twilio/status`,
    });

    const submitted = callsOf('submitCampaign');
    expect(submitted).toHaveLength(1);
    const policy = policyUrls(t.deps.config, t.seed.a.slug);
    expect((submitted[0]!.args[1] as { campaign: unknown }).campaign).toEqual(
      buildCampaign({
        companyName: 'Acme Roofing',
        companyPhone: '+14025550199',
        privacyUrl: policy.privacy,
        termsUrl: policy.terms,
      }),
    );

    const [row] = await ownerQuery<{ campaign_sid: string; campaign_status: string }>(
      'select campaign_sid, campaign_status from texting_registrations where company_id = $1',
      [companyId],
    );
    expect(row!.campaign_status).toBe('pending');
    const fees = await ownerQuery<{ unit_cost_cents: string; ref_id: string }>(
      "select unit_cost_cents, ref_id from usage_events where company_id = $1 and kind = 'texting_registration_fee' and description = $2",
      [companyId, CAMPAIGN_FEE_DESCRIPTION],
    );
    expect(fees).toHaveLength(1);
    expect(Number(fees[0]!.unit_cost_cents)).toBe(1500);
    expect(fees[0]!.ref_id).toBe(row!.campaign_sid);
  });

  test('campaign approved → a number in the area code, saved as main, texting on', async () => {
    const companyId = t.seed.a.companyId;
    await ownerQuery('update companies set phone_e164 = $2 where id = $1', [companyId, '+14025550199']);
    await addCard();
    t.registrar.setBrand('approved');
    t.registrar.setCampaign('approved');

    await submitAndDrain();

    expect(firstCall('ensureNumber')[1]).toMatchObject({ areaCode: '402', state: 'NE' });
    const numbers = await ownerQuery<{ purpose: string; status: string; e164: string }>(
      'select purpose, status, e164 from company_phone_numbers where company_id = $1',
      [companyId],
    );
    expect(numbers).toEqual([{ purpose: 'main', status: 'active', e164: '+14025550100' }]);

    const owner = await loginAs(t.app, t.seed.a.owner);
    const view = await owner.get('/api/texting');
    expect(view.body.state).toBe('approved');
    expect(view.body.number).toBe('+14025550100');

    const ctx = systemContext(companyId);
    const facts = await withTenant(t.deps.pools, ctx, (tx) => textingCompanyFacts(tx, ctx));
    expect(facts?.campaignStatus).toBe('approved');
  });

  test('a failed campaign shows Fix and resubmit', async () => {
    t.registrar.setBrand('approved');
    t.registrar.setCampaign('failed', 'some provider text');
    await addCard();

    await submitAndDrain();

    const owner = await loginAs(t.app, t.seed.a.owner);
    const view = await owner.get('/api/texting');
    expect(view.body.state).toBe('needs_fix');
    expect(view.body.reason).toBe(plainRejection('some provider text').reason);
    expect(JSON.stringify(view.body)).not.toContain('some provider text');
  });

  test('buying the number waits for a working card', async () => {
    const companyId = t.seed.a.companyId;
    t.registrar.setBrand('approved');
    t.registrar.setCampaign('approved');
    await addCard('past_due');

    await submitAndDrain();

    expect(callsOf('ensureNumber')).toHaveLength(0);
    const waiting = await ownerQuery<{ campaign_status: string }>(
      'select campaign_status from texting_registrations where company_id = $1',
      [companyId],
    );
    expect(waiting[0]!.campaign_status).toBe('pending');

    await ownerQuery("update companies set status = 'active' where id = $1", [companyId]);
    await advanceRegistration(t.deps, companyId);

    expect(callsOf('ensureNumber')).toHaveLength(1);
    const numbers = await ownerQuery(
      "select id from company_phone_numbers where company_id = $1 and purpose = 'main' and status = 'active'",
      [companyId],
    );
    expect(numbers).toHaveLength(1);
  });
});
