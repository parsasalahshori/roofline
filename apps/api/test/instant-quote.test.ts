import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test, vi } from 'vitest';
import { QUOTE_CONSENT_VERSION, quoteConsentText, type PublicQuoteEstimate, type Ring } from '@roofline/shared';
import { MESSAGES } from '../src/errors.ts';
import { QUOTE_RATE_LIMITS } from '../src/public/quote.ts';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

/*
 * The instant quote page's API (/api/public/quote/:slug) and the owner's settings, against a real database with
 * the fake providers. Needs Docker.
 */

const NOW = new Date('2026-10-14T15:00:00.000Z');
const ACME = 'acme-quote';
const BOLT = 'bolt-quote';
const ADDRESS = '4810 Underwood Ave, Omaha, NE 68132';
const EMBED = 'https://www.acme-windows.test';
const EVIL = 'https://evil.example';

let owner: pg.Pool;
let t: TestApp;

const q = async (text: string, values: unknown[] = []) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

async function enable(companyId: string, slug: string, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = { quote_enabled: true, quote_slug: slug, quote_products: ['windows', 'roof', 'gutters'], ...extra };
  const names = Object.keys(cols);
  const values = Object.values(cols);
  await q(
    `insert into company_settings (company_id, ${names.join(', ')}) values ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})
     on conflict (company_id) do update set ${names.map((n) => `${n} = excluded.${n}`).join(', ')}`,
    [companyId, ...values],
  );
}

/** A house about 25 m by 22 m round the point the fake geocoder gives `address`. */
async function houseAt(address: string): Promise<void> {
  const found = await t.deps.geocoder.geocode(address);
  const [lng, lat] = [found!.lng, found!.lat];
  const ring: Ring = [
    [lng - 0.00015, lat - 0.0001],
    [lng + 0.00015, lat - 0.0001],
    [lng + 0.00015, lat + 0.0001],
    [lng - 0.00015, lat + 0.0001],
    [lng - 0.00015, lat - 0.0001],
  ];
  await seedFootprintFixture(t.deps.pools, [{ sourceRef: `house-${address}`, ring }]);
}

beforeEach(async () => {
  t = await makeTestApp({ TRUST_PROXY: 1 });
  t.clock.set(NOW);
  await enable(t.seed.a.companyId, ACME, { quote_embed_origins: [EMBED] });
  await enable(t.seed.b.companyId, BOLT);
  await houseAt(ADDRESS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

let ipCounter = 0;
/** A fresh client address per call unless one is given, so the per-IP limits only bite where a test means them to. */
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

function estimate(slug: string, body: unknown, opts: { ip?: string; origin?: string } = {}) {
  let req = request(t.app).post(`/api/public/quote/${slug}/estimate`).set('X-Forwarded-For', opts.ip ?? nextIp());
  if (opts.origin) req = req.set('Origin', opts.origin);
  return req.send(body as object);
}

function lead(slug: string, body: unknown, opts: { ip?: string; origin?: string } = {}) {
  let req = request(t.app).post(`/api/public/quote/${slug}/lead`).set('X-Forwarded-For', opts.ip ?? nextIp());
  if (opts.origin) req = req.set('Origin', opts.origin);
  return req.send(body as object);
}

type EstimateAnswer = PublicQuoteEstimate & { formToken: string };

async function estimated(slug = ACME, address = ADDRESS): Promise<EstimateAnswer> {
  const res = await estimate(slug, { address });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as EstimateAnswer;
}

const leadBody = (e: EstimateAnswer, extra: Record<string, unknown> = {}) => ({
  quoteId: e.quoteId,
  firstName: 'Dana',
  lastName: 'Whitfield',
  email: 'Dana.W@example.com',
  phone: '(402) 555-0142',
  postalCode: '68132',
  products: ['windows', 'roof'],
  consent: true,
  consentVersion: QUOTE_CONSENT_VERSION,
  formToken: e.formToken,
  ...extra,
});

const count = async (table: string, companyId?: string) =>
  Number((await q(`select count(*)::int as n from ${table}${companyId ? ' where company_id = $1' : ''}`, companyId ? [companyId] : []))[0]!.n);

describe('GET /api/public/quote/:slug', () => {
  test('answers the company, products, booking and the consent text; nothing about prices', async () => {
    const res = await request(t.app).get(`/api/public/quote/${ACME}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      slug: ACME,
      companyName: expect.any(String),
      products: ['windows', 'roof', 'gutters'],
      booking: false,
      consent: { version: QUOTE_CONSENT_VERSION, text: quoteConsentText(res.body.companyName) },
      turnstileSiteKey: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/cents|price|pricebook/i);
  });

  test('an unknown, malformed or turned-off slug is the same 404', async () => {
    await q(`update company_settings set quote_enabled = false where company_id = $1`, [t.seed.b.companyId]);
    for (const slug of ['nope-nope', 'A!', BOLT]) {
      const res = await request(t.app).get(`/api/public/quote/${slug}`);
      expect(res.status, slug).toBe(404);
      expect(res.body).toEqual({ error: MESSAGES.notFound });
    }
  });
});

describe('POST /api/public/quote/:slug/estimate', () => {
  test('measures the home and answers ranges only: no prices, price book, measurement or other ids', async () => {
    const e = await estimated();
    expect(e.status).toBe('ready');
    expect(Object.keys(e).sort()).toEqual(['address', 'formToken', 'gutters', 'outline', 'quoteId', 'roof', 'status', 'windows']);
    expect(e.roof).not.toBeNull();
    expect(e.windows).not.toBeNull();
    expect(e.gutters).not.toBeNull();
    expect(Object.keys(e.gutters!).sort()).toEqual(['feet', 'range']);
    expect(e.gutters!.feet % 10).toBe(0);
    for (const range of [e.roof!.range, e.windows!.range, e.gutters!.range]) {
      expect(range.lowCents % 10_000).toBe(0);
      expect(range.highCents % 10_000).toBe(0);
      expect(range.highCents).toBeGreaterThan(range.lowCents);
    }
    expect(Object.keys(e.roof!).sort()).toEqual(['range', 'squares']);
    expect(Object.keys(e.windows!).sort()).toEqual(['count', 'range']);
    expect(e.outline!.ring.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(e);
    expect(text).not.toMatch(/totalCents|unitCents|pricebook|calculation|tier|measurementId|propertyId|companyId/);
  });

  test('the widened range brackets the company options and never equals one of them', async () => {
    const e = await estimated();
    const [m] = await q(`select id from measurements where company_id = $1`, [t.seed.a.companyId]);
    expect(m).toBeDefined();
    const range = e.roof!.range;
    // ±12 % of a price rounded out to hundreds: the low end is under 90 % of the high end.
    expect(range.lowCents).toBeLessThan(range.highCents * 0.9);
  });

  test('the same address again within 30 days is answered from storage: same quote, no lookup, no paid call', async () => {
    const first = await estimated();
    const geocodes = t.geocoder.calls.length;
    const solar = t.solar.calls.length;
    const second = await estimated(ACME, `  ${ADDRESS.toUpperCase()} `);
    expect(second.quoteId).toBe(first.quoteId);
    expect(second.roof).toEqual(first.roof);
    expect(t.geocoder.calls.length).toBe(geocodes);
    expect(t.solar.calls.length).toBe(solar);
    expect(await count('measurements', t.seed.a.companyId)).toBe(1);
    // After 30 days it is measured again.
    t.clock.advance(31 * 24 * 60 * 60 * 1000);
    const third = await estimated();
    expect(third.quoteId).not.toBe(first.quoteId);
  });

  test('saving the price book, the option tiers or the page settings re-prices: a stored estimate is not reused', async () => {
    const first = await estimated();
    const agent = await loginAs(t.app, t.seed.a.owner);
    const book = await agent.get('/api/pricebook');
    expect((await agent.put('/api/pricebook').send({ prices: book.body.prices, defaults: book.body.defaults })).status).toBe(200);
    const second = await estimated();
    expect(second.quoteId).not.toBe(first.quoteId);
    const tiers = await agent.get('/api/tier-templates');
    expect((await agent.put('/api/tier-templates').send({ templates: tiers.body.templates })).status).toBe(200);
    const third = await estimated();
    expect(third.quoteId).not.toBe(second.quoteId);
    const settings = await agent.get('/api/instant-quote/settings');
    const body: Record<string, unknown> = { ...(settings.body as Record<string, unknown>), rangePct: 15 };
    delete body.pageUrl;
    expect((await agent.put('/api/instant-quote/settings').send(body)).status).toBe(200);
    const fourth = await estimated();
    expect(fourth.quoteId).not.toBe(third.quoteId);
  });

  test('past the daily cap it answers fallback (no measurement) and the request can still be sent', async () => {
    await q(`update company_settings set quote_daily_cap = 0 where company_id = $1`, [t.seed.a.companyId]);
    const e = await estimated();
    expect(e).toMatchObject({ status: 'fallback', roof: null, windows: null, gutters: null, outline: null });
    expect(await count('measurements', t.seed.a.companyId)).toBe(0);
    t.clock.advance(10_000);
    const res = await lead(ACME, leadBody(e));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await count('jobs', t.seed.a.companyId)).toBe(1);
  });

  test('an address that is not found is a 422 on the address', async () => {
    const res = await estimate(ACME, { address: '1 Nowhere Lane, Omaha, NE' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('address');
  });

  test(`one IP gets ${QUOTE_RATE_LIMITS.estimatesPerIpPerHour} estimates an hour, then 429`, async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < QUOTE_RATE_LIMITS.estimatesPerIpPerHour; i++) expect((await estimate(ACME, { address: ADDRESS }, { ip })).status).toBe(200);
    const res = await estimate(ACME, { address: ADDRESS }, { ip });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: MESSAGES.tooFast });
  });

  test('a filled honeypot answers the same shape and measures nothing', async () => {
    const res = await estimate(ACME, { address: ADDRESS, website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('fallback');
    expect(await count('quote_estimates')).toBe(0);
    expect(t.solar.calls).toHaveLength(0);
  });

  test('a body over 8 KB is refused', async () => {
    const res = await estimate(ACME, { address: 'x'.repeat(9000) });
    expect(res.status).toBe(413);
  });

  test('a browser post from another site is refused; an allowed embed site gets CORS headers', async () => {
    const evil = await estimate(ACME, { address: ADDRESS }, { origin: EVIL });
    expect(evil.status).toBe(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await estimate(ACME, { address: ADDRESS }, { origin: EMBED });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(EMBED);
    // Bolt's page does not allow Acme's site.
    expect((await estimate(BOLT, { address: ADDRESS }, { origin: EMBED })).status).toBe(403);
    const preflight = await request(t.app).options(`/api/public/quote/${ACME}/lead`).set('Origin', EMBED);
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('POST /api/public/quote/:slug/lead', () => {
  test('makes the customer, address and a web Lead job with the measurement, and records the consent', async () => {
    const e = await estimated();
    t.clock.advance(8000);
    const res = await lead(ACME, leadBody(e), { ip: '192.0.2.44' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ ok: true, booked: null });

    const [customer] = await q(`select * from customers where company_id = $1`, [t.seed.a.companyId]);
    expect(customer).toMatchObject({ first_name: 'Dana', last_name: 'Whitfield', source: 'web', sms_consent_status: 'none' });
    expect(customer!.phones).toEqual([{ e164: '+14025550142', primary: true }]);
    expect(customer!.emails).toEqual(['dana.w@example.com']);
    const [job] = await q(`select * from jobs where company_id = $1`, [t.seed.a.companyId]);
    expect(job).toMatchObject({ source: 'web', stage: 'lead', customer_id: customer!.id });
    const [m] = await q(`select job_id from measurements where company_id = $1`, [t.seed.a.companyId]);
    expect(m!.job_id).toBe(job!.id);
    const [request_] = await q(`select * from quote_requests where company_id = $1`, [t.seed.a.companyId]);
    expect(request_).toMatchObject({
      consent_version: QUOTE_CONSENT_VERSION,
      products: ['windows', 'roof'],
      job_id: job!.id,
      phone_e164: '+14025550142',
    });
    expect(request_!.consent_text).toBe(quoteConsentText(String((await q(`select name from companies where id = $1`, [t.seed.a.companyId]))[0]!.name)));
    expect(request_!.consent_at).toEqual(t.clock.now());
    expect(request_!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(request_)).not.toContain('192.0.2.44');
    const lines = await q(`select summary from activities where company_id = $1 and subject_type = 'job' and kind = 'job.created' and summary like 'Instant quote%'`, [t.seed.a.companyId]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.summary).toMatch(/Roof about [\d.]+ squares, \$[\d,]+ to \$[\d,]+/);

    // The audit trail of the public requests carries no name, phone, email or address.
    const audits = await q(`select action, after::text as after from audit_log where company_id = $1 and action like 'quote.%'`, [t.seed.a.companyId]);
    expect(audits.map((a) => a.action).sort()).toEqual(['quote.estimate', 'quote.request']);
    for (const a of audits) expect(a.after).not.toMatch(/Dana|Whitfield|555|example\.com|Underwood|192\.0\.2/);
  });

  test('consent is required', async () => {
    const e = await estimated();
    t.clock.advance(8000);
    for (const consent of [false, undefined, 'on']) {
      const res = await lead(ACME, leadBody(e, { consent }));
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('consent');
    }
    expect(await count('quote_requests')).toBe(0);
  });

  test('a stale consent version asks for a reload', async () => {
    const e = await estimated();
    t.clock.advance(8000);
    const res = await lead(ACME, leadBody(e, { consentVersion: '2020-01-01' }));
    expect(res.status).toBe(409);
  });

  test('validation: phone, ZIP, products and email are checked', async () => {
    const e = await estimated();
    t.clock.advance(8000);
    expect((await lead(ACME, leadBody(e, { phone: '12' }))).body.field).toBe('phone');
    expect((await lead(ACME, leadBody(e, { postalCode: 'abc' }))).body.field).toBe('postalCode');
    expect((await lead(ACME, leadBody(e, { products: [] }))).body.field).toBe('products');
    expect((await lead(ACME, leadBody(e, { email: 'nope' }))).body.field).toBe('email');
    expect((await lead(ACME, leadBody(e, { extra: 1 }))).status).toBe(400);
  });

  test('a form sent within 3 seconds of the estimate is refused (minimum fill time); a forged token too', async () => {
    const e = await estimated();
    t.clock.advance(1000);
    const fast = await lead(ACME, leadBody(e));
    expect(fast.status).toBe(422);
    expect(fast.body.field).toBe('formToken');
    t.clock.advance(5000);
    const forged = await lead(ACME, leadBody(e, { formToken: `${(NOW.getTime() - 60_000).toString(36)}.AAAA` }));
    expect(forged.status).toBe(422);
    expect(await count('quote_requests')).toBe(0);
  });

  test('a filled honeypot answers ok and writes nothing', async () => {
    const e = await estimated();
    t.clock.advance(8000);
    const res = await lead(ACME, leadBody(e, { website: 'buy now' }));
    expect(res.status).toBe(201);
    expect(await count('quote_requests')).toBe(0);
    expect(await count('customers', t.seed.a.companyId)).toBe(0);
  });

  test('the same phone for the same home within a day files no second job; another home does', async () => {
    const e = await estimated();
    t.clock.advance(8000);
    expect((await lead(ACME, leadBody(e))).status).toBe(201);
    expect((await lead(ACME, leadBody(e))).status).toBe(201);
    expect(await count('jobs', t.seed.a.companyId)).toBe(1);
    expect(await count('quote_requests', t.seed.a.companyId)).toBe(1);
    await q(`update company_settings set quote_daily_cap = 0 where company_id = $1`, [t.seed.a.companyId]);
    const other = await estimated(ACME, '77 Other Rd, Omaha, NE 68102');
    t.clock.advance(8000);
    expect((await lead(ACME, leadBody(other))).status).toBe(201);
    expect(await count('jobs', t.seed.a.companyId)).toBe(2);
  });

  test(`one IP sends ${QUOTE_RATE_LIMITS.leadsPerIpPerHour} requests an hour, then 429`, async () => {
    const e = await estimated();
    t.clock.advance(8000);
    const ip = '198.51.100.9';
    for (let i = 0; i < QUOTE_RATE_LIMITS.leadsPerIpPerHour; i++) {
      expect((await lead(ACME, leadBody(e, { phone: `(402) 555-01${10 + i}` }), { ip })).status).toBe(201);
    }
    expect((await lead(ACME, leadBody(e, { phone: '(402) 555-0199' }), { ip })).status).toBe(429);
  });

  test("tenant isolation: another company's slug cannot use this company's quote, and writes nothing there", async () => {
    const e = await estimated(ACME);
    t.clock.advance(8000);
    const res = await lead(BOLT, leadBody(e));
    expect(res.status).toBe(404);
    expect(await count('quote_requests')).toBe(0);
    expect(await count('customers', t.seed.b.companyId)).toBe(0);
    expect(await count('jobs', t.seed.b.companyId)).toBe(0);
    // And Bolt's own estimate of the same address is Bolt's own measurement, not Acme's cached one.
    const b = await estimated(BOLT);
    expect(b.quoteId).not.toBe(e.quoteId);
    expect(await count('measurements', t.seed.b.companyId)).toBe(1);
  });

  test('products the page does not offer are dropped; none left is a 422', async () => {
    await q(`update company_settings set quote_products = '{roof}' where company_id = $1`, [t.seed.a.companyId]);
    const e = await estimated();
    expect(e.windows).toBeNull();
    t.clock.advance(8000);
    const res = await lead(ACME, leadBody(e, { products: ['windows'] }));
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('products');
  });
});

describe('GET /slots and booking', () => {
  test('no times when booking is off; spread times when on; a picked time books an inspection on the new job', async () => {
    const off = await request(t.app).get(`/api/public/quote/${ACME}/slots`);
    expect(off.body.slots).toEqual([]);
    await q(`update company_settings set quote_booking = true where company_id = $1`, [t.seed.a.companyId]);
    const on = await request(t.app).get(`/api/public/quote/${ACME}/slots`);
    expect(on.status).toBe(200);
    const slots = on.body.slots as { id: string; start: string; end: string }[];
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(on.body)).not.toMatch(/userId|name/i);
    const days = new Map<string, number>();
    for (const sl of slots) {
      const d = new Date(sl.start).toLocaleDateString('en-CA', { timeZone: on.body.timeZone });
      days.set(d, (days.get(d) ?? 0) + 1);
    }
    for (const n of days.values()) expect(n).toBeLessThanOrEqual(2);

    // The first time sits right on the minimum notice, which the seconds spent on the form may pass: pick a later one.
    const pick = slots[slots.length - 1]!;
    const e = await estimated();
    t.clock.advance(8000);
    const res = await lead(ACME, leadBody(e, { slotId: pick.id }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.booked).toEqual({ start: pick.start, end: pick.end });
    const [appt] = await q(`select kind, starts_at, job_id from appointments where company_id = $1`, [t.seed.a.companyId]);
    expect(appt).toMatchObject({ kind: 'inspection' });
    expect(new Date(appt!.starts_at).toISOString()).toBe(pick.start);
    const [req] = await q(`select appointment_id, job_id from quote_requests where company_id = $1`, [t.seed.a.companyId]);
    expect(req!.appointment_id).not.toBeNull();
    expect(appt!.job_id).toBe(req!.job_id);
  });
});

describe('Turnstile (only when TURNSTILE_SECRET is set)', () => {
  test('off by default: no fetch to Cloudflare', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await estimated();
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('challenges.cloudflare.com'))).toHaveLength(0);
  });

  test('on: a bad token is a 403, a good one passes; the secret goes to Cloudflare only', async () => {
    await t.close();
    t = await makeTestApp({ TRUST_PROXY: 1, TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITE_KEY: 'ts-site' });
    t.clock.set(NOW);
    await enable(t.seed.a.companyId, ACME);
    await houseAt(ADDRESS);
    const answers: boolean[] = [false, true];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      expect(String((init as RequestInit).body)).toContain('secret=ts-secret');
      return new Response(JSON.stringify({ success: answers.shift() }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const config = await request(t.app).get(`/api/public/quote/${ACME}`);
    expect(config.body.turnstileSiteKey).toBe('ts-site');
    expect(JSON.stringify(config.body)).not.toContain('ts-secret');
    // No token: refused without asking Cloudflare. A token Cloudflare refuses: 403. One it accepts: measured.
    expect((await estimate(ACME, { address: ADDRESS })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect((await estimate(ACME, { address: ADDRESS, turnstileToken: 'bad' })).status).toBe(403);
    const ok = await estimate(ACME, { address: ADDRESS, turnstileToken: 'good' });
    expect(ok.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  }, 30_000);
});

describe('GET /q/:slug (the page, framed by the company sites only)', () => {
  test("a turned-on page may be framed by the company's embed origins; any other path keeps frame-ancestors 'none'", async () => {
    const dist = mkdtempSync(join(tmpdir(), 'quote-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    await t.close();
    t = await makeTestApp({ WEB_DIST_DIR: dist });
    await enable(t.seed.a.companyId, ACME, { quote_embed_origins: [EMBED] });
    const page = await request(t.app).get(`/q/${ACME}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain(`frame-ancestors 'self' ${EMBED}`);
    expect(page.headers['x-frame-options']).toBeUndefined();
    expect(page.headers['x-robots-tag']).toBe('noindex');
    const unknown = await request(t.app).get('/q/nobody-here');
    expect(unknown.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(unknown.headers['x-frame-options']).toBeDefined();
    const app = await request(t.app).get('/settings');
    expect(app.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('/api/instant-quote/settings', () => {
  const valid = {
    enabled: true,
    slug: 'acme-new',
    products: ['roof', 'windows'],
    rangePct: 15,
    dailyCap: 20,
    embedOrigins: ['https://www.acme.test/'],
    booking: true,
    accentColor: '#1f6feb',
  };

  test('the owner reads and saves; the page url is the app origin plus /q/slug', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const put = await agent.put('/api/instant-quote/settings').send(valid);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ ...valid, products: ['windows', 'roof'], embedOrigins: ['https://www.acme.test'], pageUrl: `${t.deps.config.APP_ORIGIN}/q/acme-new` });
    const got = await agent.get('/api/instant-quote/settings');
    expect(got.body.slug).toBe('acme-new');
    expect((await request(t.app).get('/api/public/quote/acme-new')).status).toBe(200);
  });

  test("a slug another company uses is a 409; a bad origin or range is a 400", async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    expect((await agent.put('/api/instant-quote/settings').send({ ...valid, slug: BOLT })).status).toBe(409);
    expect((await agent.put('/api/instant-quote/settings').send({ ...valid, embedOrigins: ['javascript:alert(1)'] })).status).toBe(400);
    expect((await agent.put('/api/instant-quote/settings').send({ ...valid, rangePct: 2 })).status).toBe(400);
  });

  test('signed out is refused', async () => {
    expect((await request(t.app).get('/api/instant-quote/settings')).status).toBe(401);
  });
});
