import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { stormRequests, withTenant, type TenantContext } from '@roofline/db';
import { PUBLIC_RATE_LIMIT_PER_MIN } from '../src/rate-limit.ts';
import { MESSAGES } from '../src/errors.ts';
import { STORM_CONSENT_TEXT, STORM_REQUEST_LIMITS } from '../src/storm/landing-copy.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * POST /api/public/storm-requests/:code (S1 Task 20) against a real database. Storms are global
 * tables and come from the shared fixtures; the storm pages and the company storms are inserted
 * through the owner connection. Needs Docker: these run on CI only.
 */

const ACME_CODE = 'k7m2p5qa';
const BOLT_CODE = 'bq4t7w2z';
const LAPSED_CODE = 'lapsed23';
const UNKNOWN_CODE = 'zzzzzzzz';
const ACME_ORIGIN = 'https://acme-roofing.roofline.test';
const BOLT_ORIGIN = 'https://bolt-roofing.roofline.test';
const EVIL_ORIGIN = 'https://evil.example';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const FORM = { name: 'Jane Doe', phone: '(402) 555-0100', address: '1200 Farnam St, Omaha, NE 68102' };

let owner: pg.Pool;
let t: TestApp;
let stormId: string;
let acmePageId: string;
let boltPageId: string;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});

afterAll(async () => {
  await owner.end();
});

/** Inserts a storm page for a company's storm: the company storm row first, then the page. */
async function makePage(companyId: string, code: string, activeUntil: Date): Promise<string> {
  const [companyStorm] = await q(
    'insert into company_storms (company_id, storm_id, max_in) values ($1, $2, 1.5) on conflict (company_id, storm_id) do update set max_in = excluded.max_in returning id',
    [companyId, stormId],
  );
  const [page] = await q(
    'insert into storm_pages (company_id, company_storm_id, code, active_until) values ($1, $2, $3, $4) returning id',
    [companyId, companyStorm!.id, code, activeUntil],
  );
  return page!.id as string;
}

beforeEach(async () => {
  // TRUST_PROXY 1 makes req.ip the X-Forwarded-For address, so one test can look like many homes.
  t = await makeTestApp({ TRUST_PROXY: 1 });
  const now = t.clock.now();
  stormId = await insertOmahaStorm(q, '2026-10-11');
  acmePageId = await makePage(t.seed.a.companyId, ACME_CODE, new Date(now.getTime() + 30 * DAY_MS));
  boltPageId = await makePage(t.seed.b.companyId, BOLT_CODE, new Date(now.getTime() + 30 * DAY_MS));
  await makePage(t.seed.a.companyId, LAPSED_CODE, new Date(now.getTime() - DAY_MS));
});

afterEach(async () => {
  await t.close();
});


/** Posts a storm request as JSON, optionally with an Origin header and a client address. */
function post(code: string, body: unknown, options: { origin?: string; ip?: string } = {}) {
  let req = request(t.app).post(`/api/public/storm-requests/${code}`);
  if (options.origin !== undefined) req = req.set('Origin', options.origin);
  if (options.ip !== undefined) req = req.set('X-Forwarded-For', options.ip);
  return req.send(body as object);
}

/** Counts the rows of a table for one company (or all rows when no company is given). */
async function countRows(table: string, companyId?: string): Promise<number> {
  const rows = companyId
    ? await q(`select count(*)::int as n from ${table} where company_id = $1`, [companyId])
    : await q(`select count(*)::int as n from ${table}`);
  return Number(rows[0]!.n);
}

const acme = () => t.seed.a.companyId;
const bolt = () => t.seed.b.companyId;

describe('POST /api/public/storm-requests/:code', () => {
  test('a JSON post with the company Origin is accepted and makes one web lead job on the storm', async () => {
    const res = await post(ACME_CODE, { ...FORM, okToText: 'on' }, { origin: ACME_ORIGIN });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    const jobs = await q('select source, stage, storm_id from jobs where company_id = $1', [acme()]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source: 'web', stage: 'lead' });
    expect(jobs[0]!.storm_id).not.toBeNull();
  });

  test('a post from a foreign Origin is refused with 403 and writes nothing', async () => {
    const res = await post(ACME_CODE, { ...FORM, okToText: 'on' }, { origin: EVIL_ORIGIN });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: MESSAGES.crossSite });
    expect(await countRows('storm_requests')).toBe(0);
    expect(await countRows('customers')).toBe(0);
    expect(await countRows('jobs')).toBe(0);
  });

  test('a post from another company host is refused for this company page', async () => {
    const res = await post(ACME_CODE, FORM, { origin: BOLT_ORIGIN });

    expect(res.status).toBe(403);
    expect(await countRows('storm_requests')).toBe(0);
  });

  test('a post with no Origin header (a script, not a browser) is accepted', async () => {
    const res = await post(ACME_CODE, FORM);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(await countRows('jobs', acme())).toBe(1);
  });

  test('a filled honeypot answers 201 and writes no storm request, customer or job', async () => {
    const res = await post(ACME_CODE, { ...FORM, okToText: 'on', website: 'http://spam.example' }, { origin: ACME_ORIGIN });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(await countRows('storm_requests')).toBe(0);
    expect(await countRows('customers')).toBe(0);
    expect(await countRows('jobs')).toBe(0);
  });

  test('a second request with the same phone on the same page answers 201 and makes no second job', async () => {
    const first = await post(ACME_CODE, FORM, { origin: ACME_ORIGIN });
    const second = await post(ACME_CODE, { ...FORM, name: 'Jane Again' }, { origin: ACME_ORIGIN });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ ok: true });
    expect(await countRows('jobs', acme())).toBe(1);
    expect(await countRows('storm_requests', acme())).toBe(1);
  });

  test('a ticked box is recorded on the request as the ask, but the new customer stays at none (Ruling BF)', async () => {
    await post(ACME_CODE, { ...FORM, phone: '(402) 555-0101', okToText: 'on' }, { origin: ACME_ORIGIN });

    const [customer] = await q(
      'select sms_consent_status, sms_consent_source, sms_consent_evidence from customers where company_id = $1 and phones::text like $2',
      [acme(), '%+14025550101%'],
    );
    expect(customer).toMatchObject({ sms_consent_status: 'none', sms_consent_source: null, sms_consent_evidence: null });
    const [row] = await q('select sms_consent, consent_text, consent_at from storm_requests where company_id = $1', [acme()]);
    expect(row).toMatchObject({ sms_consent: true, consent_text: STORM_CONSENT_TEXT });
    expect(row!.consent_at).not.toBeNull();
  });

  test('the form never changes an existing customer, and sends no text', async () => {
    await q(
      `insert into customers (company_id, display_name, phones, source, sms_consent_status)
       values ($1, 'Pat Existing', $2::jsonb, 'manual', 'none')`,
      [acme(), JSON.stringify([{ e164: '+14025550103', primary: true }])],
    );
    const res = await post(ACME_CODE, { ...FORM, phone: '(402) 555-0103', okToText: 'on' }, { origin: ACME_ORIGIN });

    expect(res.status).toBe(201);
    const customers = await q('select sms_consent_status, sms_consent_source from customers where company_id = $1', [acme()]);
    expect(customers).toEqual([{ sms_consent_status: 'none', sms_consent_source: null }]);
    expect(await countRows('messages', acme())).toBe(0);
  });

  test('a ticked box without a YES leaves no consent audit row', async () => {
    await post(ACME_CODE, { ...FORM, phone: '(402) 555-0104', okToText: 'on' }, { origin: ACME_ORIGIN });

    const rows = await q("select 1 from audit_log where company_id = $1 and action like 'customer.consent%'", [acme()]);
    expect(rows).toHaveLength(0);
  });

  test('a repeat of the same phone on the page is accepted silently: no second customer or job', async () => {
    await post(ACME_CODE, { ...FORM, phone: '(402) 555-0105' }, { origin: ACME_ORIGIN, ip: '198.51.100.71' });
    const again = await post(ACME_CODE, { ...FORM, phone: '(402) 555-0105', name: 'Other' }, { origin: ACME_ORIGIN, ip: '198.51.100.72' });

    expect(again.status).toBe(201);
    expect(await countRows('customers', acme())).toBe(1);
    expect(await countRows('jobs', acme())).toBe(1);
    expect(STORM_REQUEST_LIMITS.perPhonePerPage).toBe(1);
  });

  test('one address gets only its share of one page in an hour, and another address is still served', async () => {
    const ip = '198.51.100.80';
    for (let i = 0; i < STORM_REQUEST_LIMITS.perIpPerPagePerHour; i++) {
      const ok = await post(ACME_CODE, { ...FORM, phone: `(402) 555-081${i}` }, { origin: ACME_ORIGIN, ip });
      expect(ok.status).toBe(201);
    }
    const refused = await post(ACME_CODE, { ...FORM, phone: '(402) 555-0819' }, { origin: ACME_ORIGIN, ip });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: MESSAGES.tooFast });

    expect((await post(ACME_CODE, { ...FORM, phone: '(402) 555-0820' }, { origin: ACME_ORIGIN, ip: '198.51.100.81' })).status).toBe(201);
    expect(await countRows('storm_requests', acme())).toBe(STORM_REQUEST_LIMITS.perIpPerPagePerHour + 1);
  });

  test('the per-page budget needs at least 25 addresses to fill', () => {
    expect(STORM_REQUEST_LIMITS.perPagePerHour / STORM_REQUEST_LIMITS.perIpPerPagePerHour).toBeGreaterThanOrEqual(25);
  });

  test('an address the geocoder cannot find is a 422 on the address field', async () => {
    const res = await post(ACME_CODE, { ...FORM, address: '1 Nowhere Rd, Omaha, NE 68102' }, { origin: ACME_ORIGIN });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "We couldn't find that address. Please check it.", field: 'address' });
    expect(await countRows('jobs')).toBe(0);
  });

  test('a page whose storm window has closed is a 404', async () => {
    const res = await post(LAPSED_CODE, FORM, { origin: ACME_ORIGIN });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: MESSAGES.notFound });
    expect(await countRows('storm_requests')).toBe(0);
  });

  test('an unknown code is a 404', async () => {
    const res = await post(UNKNOWN_CODE, FORM);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: MESSAGES.notFound });
  });

  test('the sixth post in an hour from one address, across pages, is a 429', async () => {
    const ip = '198.51.100.20';
    // One address may only take its share of each page, so the five allowed posts go to three pages.
    const otherStorm = await insertOmahaStorm(q, '2026-10-09');
    const [cs] = await q(
      'insert into company_storms (company_id, storm_id, max_in) values ($1, $2, 1.5) returning id',
      [acme(), otherStorm],
    );
    await q('insert into storm_pages (company_id, company_storm_id, code, active_until) values ($1, $2, $3, $4)', [
      acme(),
      cs!.id,
      'm3n4p5qr',
      new Date(t.clock.now().getTime() + 30 * DAY_MS),
    ]);
    const targets = [ACME_CODE, ACME_CODE, 'm3n4p5qr', 'm3n4p5qr', BOLT_CODE];
    for (const [i, code] of targets.entries()) {
      const origin = code === BOLT_CODE ? BOLT_ORIGIN : ACME_ORIGIN;
      const res = await post(code, { ...FORM, phone: `(402) 555-03${i}0` }, { origin, ip });
      expect(res.status).toBe(201);
    }

    const sixth = await post(BOLT_CODE, { ...FORM, phone: '(402) 555-0399' }, { origin: BOLT_ORIGIN, ip });
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ error: MESSAGES.tooFast });
    expect(await countRows('storm_requests')).toBe(STORM_REQUEST_LIMITS.perIpPerHour);
  });

  test('a page at its hourly limit answers 429 to a new address, and older requests do not count', async () => {
    const now = t.clock.now();
    // Requests older than an hour do not count against the page.
    await q(
      `insert into storm_requests (company_id, storm_page_id, name, phone_e164, address, created_at, updated_at)
       select $1, $2, 'Old', '+1402' || lpad(g::text, 7, '0'), '1 Old St', $3, $3
       from generate_series(1, $4) g`,
      [acme(), acmePageId, new Date(now.getTime() - 2 * HOUR_MS), STORM_REQUEST_LIMITS.perPagePerHour],
    );
    expect((await post(ACME_CODE, { ...FORM, phone: '(402) 555-0500' }, { origin: ACME_ORIGIN, ip: '198.51.100.31' })).status).toBe(201);

    // Requests from the last hour fill the page's allowance.
    await q(
      `insert into storm_requests (company_id, storm_page_id, name, phone_e164, address, created_at, updated_at)
       select $1, $2, 'Recent', '+1403' || lpad(g::text, 7, '0'), '1 Recent St', $3, $3
       from generate_series(1, $4) g`,
      [acme(), acmePageId, new Date(now.getTime() - 5 * 60 * 1000), STORM_REQUEST_LIMITS.perPagePerHour],
    );
    const refused = await post(ACME_CODE, { ...FORM, phone: '(402) 555-0600' }, { origin: ACME_ORIGIN, ip: '198.51.100.32' });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: MESSAGES.tooFast });
  });

  test('a urlencoded form post redirects with 303 to the thank-you page on the same host', async () => {
    const res = await request(t.app)
      .post(`/api/public/storm-requests/${ACME_CODE}`)
      .set('Origin', ACME_ORIGIN)
      .type('form')
      .send('name=Jane+Doe&phone=%28402%29+555-0700&address=1200+Farnam+St%2C+Omaha%2C+NE+68102&okToText=on');

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/storm/${ACME_CODE}/thanks`);
    expect(await countRows('jobs', acme())).toBe(1);
  });

  test('a urlencoded form with a bad phone redirects with 303 to the page with ?error=phone', async () => {
    const res = await request(t.app)
      .post(`/api/public/storm-requests/${ACME_CODE}`)
      .set('Origin', ACME_ORIGIN)
      .type('form')
      .send('name=Jane+Doe&phone=123&address=1200+Farnam+St%2C+Omaha%2C+NE+68102');

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/storm/${ACME_CODE}?error=phone`);
    expect(await countRows('jobs')).toBe(0);
  });

  test('the same bad phone as JSON is still a 422 with the field', async () => {
    const res = await post(ACME_CODE, { ...FORM, phone: '123' }, { origin: ACME_ORIGIN });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'phone' });
  });

  test('a urlencoded post to a closed or unknown page redirects with 303 to the page', async () => {
    const closed = await request(t.app)
      .post(`/api/public/storm-requests/${LAPSED_CODE}`)
      .type('form')
      .send('name=Jane+Doe&phone=%28402%29+555-0900&address=1200+Farnam+St%2C+Omaha%2C+NE+68102');
    expect(closed.status).toBe(303);
    expect(closed.headers.location).toBe(`/storm/${LAPSED_CODE}`);

    const unknown = await request(t.app)
      .post(`/api/public/storm-requests/${UNKNOWN_CODE}`)
      .type('form')
      .send('name=Jane+Doe&phone=%28402%29+555-0901&address=1200+Farnam+St%2C+Omaha%2C+NE+68102');
    expect(unknown.status).toBe(303);
    expect(unknown.headers.location).toBe(`/storm/${UNKNOWN_CODE}`);
  });

  test('a foreign Origin on a urlencoded post is still refused with 403, not redirected', async () => {
    const res = await request(t.app)
      .post(`/api/public/storm-requests/${ACME_CODE}`)
      .set('Origin', EVIL_ORIGIN)
      .type('form')
      .send('name=Jane+Doe&phone=%28402%29+555-0902&address=1200+Farnam+St%2C+Omaha%2C+NE+68102');

    expect(res.status).toBe(403);
    expect(await countRows('storm_requests')).toBe(0);
  });

  test("another company's requests are invisible to the first company", async () => {
    await post(ACME_CODE, { ...FORM, phone: '(402) 555-0800' }, { origin: ACME_ORIGIN });
    await post(BOLT_CODE, { ...FORM, phone: '(402) 555-0801' }, { origin: BOLT_ORIGIN });

    // Each company is read as its own owner, the way the app reads it, so row-level security decides what is visible.
    const asOwner = (companyId: string, userId: string): TenantContext => ({ companyId, userId, role: 'owner', canApproveSpend: true });
    const acmeRows = await withTenant(t.deps.pools, asOwner(acme(), t.seed.a.owner.userId), (tx) => tx.select().from(stormRequests));
    const boltRows = await withTenant(t.deps.pools, asOwner(bolt(), t.seed.b.owner.userId), (tx) => tx.select().from(stormRequests));

    expect(acmeRows).toHaveLength(1);
    expect(acmeRows[0]!.stormPageId).toBe(acmePageId);
    expect(boltRows).toHaveLength(1);
    expect(boltRows[0]!.stormPageId).toBe(boltPageId);
  });
});

const FORM_BODY = 'name=Jane+Doe&phone=%28402%29+555-0950&address=1200+Farnam+St%2C+Omaha%2C+NE+68102';

describe('the landing code rule', () => {
  test.each(['bad-code', 'abc12345', 'abcd23456', 'abcd234', 'k7m2p9qa'])('a malformed code %s is a 404 as JSON and not a page', async (code) => {
    const res = await post(code, FORM);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: MESSAGES.notFound });
    expect(await countRows('storm_requests')).toBe(0);
  });

  test('a malformed code on a urlencoded post is a 404, not a redirect to a page that cannot exist', async () => {
    const res = await request(t.app).post('/api/public/storm-requests/abc12345').type('form').send(FORM_BODY);

    expect(res.status).toBe(404);
  });
});

describe('form-friendly failures', () => {
  /** Uses up the public limit with cheap GETs from one address (they never reach the per-IP form limit). */
  async function useUpPublicLimit(ip: string): Promise<void> {
    for (let i = 0; i < PUBLIC_RATE_LIMIT_PER_MIN; i += 1) {
      await request(t.app).get('/api/public/storm-requests/x').set('X-Forwarded-For', ip);
    }
  }

  test('a urlencoded form that trips the public rate limit is redirected with ?error=busy', async () => {
    const ip = '198.51.100.60';
    await useUpPublicLimit(ip);

    const res = await request(t.app).post(`/api/public/storm-requests/${ACME_CODE}`).set('X-Forwarded-For', ip).type('form').send(FORM_BODY);

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/storm/${ACME_CODE}?error=busy`);
    expect(await countRows('storm_requests')).toBe(0);
  });

  test('a JSON post that trips the public rate limit keeps its JSON 429', async () => {
    const ip = '198.51.100.61';
    await useUpPublicLimit(ip);

    const res = await post(ACME_CODE, FORM, { ip });

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: MESSAGES.tooFast });
  });

  test('a urlencoded form that trips the per-address limit is redirected with ?error=busy', async () => {
    const ip = '198.51.100.62';
    for (let i = 0; i < STORM_REQUEST_LIMITS.perIpPerHour; i += 1) {
      await post(ACME_CODE, { ...FORM, phone: `(402) 555-04${i}0` }, { origin: ACME_ORIGIN, ip });
    }

    const res = await request(t.app).post(`/api/public/storm-requests/${ACME_CODE}`).set('X-Forwarded-For', ip).type('form').send(FORM_BODY);

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/storm/${ACME_CODE}?error=busy`);
  });

  test('a urlencoded body over the size limit is redirected with ?error=invalid', async () => {
    const res = await request(t.app)
      .post(`/api/public/storm-requests/${ACME_CODE}`)
      .type('form')
      .send(`name=Jane&address=${'a'.repeat(9000)}`);

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/storm/${ACME_CODE}?error=invalid`);
    expect(await countRows('storm_requests')).toBe(0);
  });

  test('a urlencoded body the parser cannot read is redirected with ?error=invalid', async () => {
    const res = await request(t.app)
      .post(`/api/public/storm-requests/${ACME_CODE}`)
      .set('Content-Type', 'application/x-www-form-urlencoded; charset=utf-16')
      .send(FORM_BODY);

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/storm/${ACME_CODE}?error=invalid`);
  });

  test('a JSON body over the size limit keeps its JSON 413', async () => {
    const res = await post(ACME_CODE, { ...FORM, address: 'a'.repeat(9000) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: MESSAGES.tooLarge });
  });

  test('a malformed JSON body keeps its JSON 400', async () => {
    const res = await request(t.app)
      .post(`/api/public/storm-requests/${ACME_CODE}`)
      .set('Content-Type', 'application/json')
      .send('{"name": ');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: MESSAGES.unreadable });
  });
});
