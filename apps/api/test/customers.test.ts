import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { activities, auditLog, customers, jobs, optOuts, properties, withTenant, type Tx } from '@roofline/db';
import type { SeedUser } from '@roofline/db/testing';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NOT_FOUND = "We couldn't find that.";
const CHECK_FIELD = 'Please check this field.';
const NOTHING = "There's nothing to change.";
const BAD_PHONE = "That doesn't look like a US phone number.";
const LISTED_TWICE = 'This number is listed twice.';
const TAKEN = 'Another customer already has this number.';
const ATTESTED = 'That consent type can only come from a customer import.';
const NAME_MESSAGE = 'Please enter a name.';
const EMAIL_MESSAGE = 'Please enter a valid email address.';
const NOT_A_NUMBER = 'Please use a whole number from 1 to 200.';
const NOTE_MESSAGE = 'A note can only be added when texting consent is set to OK for offers.';
const NO_UUID = '00000000-0000-4000-8000-000000000000';

const MOLLY = '(402) 555-0144';
const MOLLY_E164 = '+14025550144';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

// ---------------------------------------------------------------------------------------------
// helpers

type Who = 'owner' | 'office' | 'rep' | 'otherRep';

const logins = new Map<string, Promise<SuperAgent>>();
beforeEach(() => logins.clear());

/** A signed-in agent for one of company A's four members (one login per test). */
function agentFor(who: Who, company: 'a' | 'b' = 'a'): Promise<SuperAgent> {
  const key = `${company}:${who}`;
  let agent = logins.get(key);
  if (!agent) {
    agent = loginAs(t.app, t.seed[company][who]);
    logins.set(key, agent);
  }
  return agent;
}

const userOf = (who: Who, company: 'a' | 'b' = 'a'): SeedUser => t.seed[company][who];

/** A system-role context for looking at the tenant tables directly, inside a transaction. */
function inCompany<T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(t.deps.pools, { companyId, userId: null, role: 'system', canApproveSpend: false }, fn);
}

const dbCustomer = (companyId: string, id: string) =>
  inCompany(companyId, async (tx) => (await tx.select().from(customers).where(eq(customers.id, id)))[0]!);

const dbOptOuts = (companyId: string) =>
  inCompany(companyId, async (tx) => (await tx.select().from(optOuts)).sort((a, b) => a.phoneE164.localeCompare(b.phoneE164)));

const dbActivities = (companyId: string, subjectId: string) =>
  inCompany(companyId, (tx) => tx.select().from(activities).where(eq(activities.subjectId, subjectId)));

const dbAudit = (companyId: string, action: string) =>
  inCompany(companyId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, action)));

type Created = { id: string } & Record<string, unknown>;

/** Creates a customer as `who` and returns the response body; fails the test when it is not a 201. */
async function create(who: Who, body: Record<string, unknown>, company: 'a' | 'b' = 'a'): Promise<Created> {
  const agent = await agentFor(who, company);
  const res = await agent.post('/api/customers').send(body);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Created;
}

const ids = (list: { id: string }[]) => list.map((c) => c.id);
const names = (res: { body: { customers: { displayName: string }[] } }) => res.body.customers.map((c) => c.displayName);

// ---------------------------------------------------------------------------------------------

describe('creating a customer', () => {
  test('stores the number as E.164, makes it primary, and answers with the documented shape', async () => {
    t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
    const owner = await agentFor('owner');
    const res = await owner.post('/api/customers').send({
      displayName: '  Molly Lindgren ',
      firstName: 'Molly',
      lastName: 'Lindgren',
      phones: [{ number: MOLLY, label: 'mobile' }],
      emails: [' Molly@Example.com '],
      tags: ['hail', 'vip'],
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      displayName: 'Molly Lindgren',
      firstName: 'Molly',
      lastName: 'Lindgren',
      phones: [{ number: MOLLY_E164, label: 'mobile', primary: true }],
      emails: ['molly@example.com'],
      tags: ['hail', 'vip'],
      doNotContact: false,
      smsConsent: { status: 'none', source: null, at: null },
      source: 'manual',
      createdByUserId: userOf('owner').userId,
      archivedAt: null,
      createdAt: '2026-10-12T15:00:00.000Z',
      updatedAt: '2026-10-12T15:00:00.000Z',
    });

    const stored = await dbCustomer(t.seed.a.companyId, res.body.id);
    expect(stored.phones).toEqual([{ e164: MOLLY_E164, label: 'mobile', primary: true }]);
  });

  test('a customer with only a name is fine; the lists default to empty', async () => {
    const res = await (await agentFor('office')).post('/api/customers').send({ displayName: 'Walk-in' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ phones: [], emails: [], tags: [], firstName: null, lastName: null });
  });

  test('a second customer written 402.555.0144 is refused: 409 on that phone', async () => {
    await create('owner', { displayName: 'Molly Lindgren', phones: [{ number: MOLLY }] });
    const res = await (await agentFor('office')).post('/api/customers').send({
      displayName: 'Molly again',
      phones: [{ number: '402.555.0144' }],
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: TAKEN, field: 'phones.0.number' });
    expect((await inCompany(t.seed.a.companyId, (tx) => tx.select().from(customers))).length).toBe(1);
  });

  test.each(['+1 402 555 0144', '4025550144', '1-402-555-0144'])('%s is the same number', async (written) => {
    await create('owner', { displayName: 'Molly Lindgren', phones: [{ number: MOLLY }] });
    const res = await (await agentFor('owner')).post('/api/customers').send({
      displayName: 'Other',
      phones: [{ number: written }],
    });
    expect(res.status).toBe(409);
    expect(res.body.field).toBe('phones.0.number');
  });

  test('the 409 names the phone that clashed, by its place in the request', async () => {
    await create('owner', { displayName: 'Molly Lindgren', phones: [{ number: MOLLY }] });
    const res = await (await agentFor('owner')).post('/api/customers').send({
      displayName: 'Other',
      phones: [{ number: '(308) 555-0111' }, { number: MOLLY }],
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: TAKEN, field: 'phones.1.number' });
  });

  test('the same number in another company, or on an archived customer, is not a duplicate', async () => {
    const first = await create('owner', { displayName: 'Molly Lindgren', phones: [{ number: MOLLY }] });
    const elsewhere = await (await agentFor('owner', 'b')).post('/api/customers').send({
      displayName: 'Molly in B',
      phones: [{ number: MOLLY }],
    });
    expect(elsewhere.status).toBe(201);

    expect((await (await agentFor('owner')).post(`/api/customers/${first.id}/archive`)).status).toBe(200);
    const reused = await (await agentFor('owner')).post('/api/customers').send({
      displayName: 'New owner of the number',
      phones: [{ number: MOLLY }],
    });
    expect(reused.status).toBe(201);
  });

  test('555-0144 (no area code) → 400 on that phone', async () => {
    const res = await (await agentFor('owner')).post('/api/customers').send({
      displayName: 'Molly',
      phones: [{ number: '555-0144' }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: BAD_PHONE, field: 'phones.0.number' });
  });

  test('a bad number later in the list names its own position', async () => {
    const res = await (await agentFor('owner')).post('/api/customers').send({
      displayName: 'Molly',
      phones: [{ number: MOLLY }, { number: 'call me' }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: BAD_PHONE, field: 'phones.1.number' });
  });

  test('the same number twice in one customer → 400 on the second one, even written differently', async () => {
    const res = await (await agentFor('owner')).post('/api/customers').send({
      displayName: 'Molly',
      phones: [{ number: MOLLY }, { number: '(308) 555-0111' }, { number: '+1 402-555-0144' }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: LISTED_TWICE, field: 'phones.2.number' });
  });

  test('a fictional (555) area code is accepted', async () => {
    const res = await (await agentFor('owner')).post('/api/customers').send({
      displayName: 'Test Customer',
      phones: [{ number: '(555) 555-0144' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.phones[0].number).toBe('+15555550144');
  });

  test('primary: the first becomes primary when none is marked; only the first marked one is kept', async () => {
    const none = await create('owner', {
      displayName: 'None marked',
      phones: [{ number: '(402) 555-0101' }, { number: '(402) 555-0102' }],
    });
    expect(none.phones).toEqual([
      { number: '+14025550101', label: null, primary: true },
      { number: '+14025550102', label: null, primary: false },
    ]);

    const two = await create('owner', {
      displayName: 'Two marked',
      phones: [
        { number: '(402) 555-0103' },
        { number: '(402) 555-0104', primary: true },
        { number: '(402) 555-0105', primary: true },
      ],
    });
    expect((two.phones as { primary: boolean }[]).map((p) => p.primary)).toEqual([false, true, false]);
  });

  test('only the owner and the office may set consent or do-not-contact; a rep gets 403 and nothing is saved', async () => {
    const rep = await agentFor('rep');
    for (const body of [
      { displayName: 'A', smsConsentStatus: 'express' },
      { displayName: 'B', smsConsentStatus: 'attested' },
      { displayName: 'C', doNotContact: true },
      { displayName: 'D', doNotContact: false },
      { displayName: 'E', smsConsentStatus: 'written', consentNote: 'On the phone' },
    ]) {
      const res = await rep.post('/api/customers').send(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body).toEqual({ error: NOT_ALLOWED });
    }
    expect((await inCompany(t.seed.a.companyId, (tx) => tx.select().from(customers))).length).toBe(0);
  });

  test('a rep can create a customer (with no consent fields) and it remembers who made it', async () => {
    const res = await (await agentFor('rep')).post('/api/customers').send({
      displayName: 'Rep Find',
      phones: [{ number: '(402) 555-0150' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.createdByUserId).toBe(userOf('rep').userId);
    expect(res.body.smsConsent).toEqual({ status: 'none', source: null, at: null });
  });

  test('the owner can record consent when creating; it is a manual change by that person, now', async () => {
    t.clock.set(new Date('2026-10-12T16:30:00.000Z'));
    const res = await (await agentFor('office')).post('/api/customers').send({
      displayName: 'Consenting',
      phones: [{ number: MOLLY }],
      smsConsentStatus: 'written',
      consentNote: 'Signed the offers form on the roof visit',
    });
    expect(res.status).toBe(201);
    expect(res.body.smsConsent).toEqual({ status: 'written', source: 'manual', at: '2026-10-12T16:30:00.000Z' });
    const stored = await dbCustomer(t.seed.a.companyId, res.body.id);
    expect(stored.smsConsentByUserId).toBe(userOf('office').userId);
    expect(stored.smsConsentEvidence).toEqual({ note: 'Signed the offers form on the roof visit' });
    expect(stored.smsConsentAt).toEqual(new Date('2026-10-12T16:30:00.000Z'));
  });

  test('creating a do-not-contact customer puts every phone on the opt-out list', async () => {
    t.clock.set(new Date('2026-10-12T17:00:00.000Z'));
    await create('owner', {
      displayName: 'Do not call',
      doNotContact: true,
      phones: [{ number: '(402) 555-0102' }, { number: '(402) 555-0101' }],
    });
    const rows = await dbOptOuts(t.seed.a.companyId);
    expect(rows.map((r) => [r.phoneE164, r.keyword, r.at.toISOString()])).toEqual([
      ['+14025550101', 'manual', '2026-10-12T17:00:00.000Z'],
      ['+14025550102', 'manual', '2026-10-12T17:00:00.000Z'],
    ]);
  });

  test('two requests at the same moment with the same number: exactly one 201 and one 409', async () => {
    const owner = await agentFor('owner');
    const [one, two] = await Promise.all([
      owner.post('/api/customers').send({ displayName: 'Racer One', phones: [{ number: '(402) 555-0177' }] }),
      owner.post('/api/customers').send({ displayName: 'Racer Two', phones: [{ number: '402.555.0177' }] }),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    const loser = one.status === 409 ? one : two;
    expect(loser.body).toEqual({ error: TAKEN, field: 'phones.0.number' });
    const rows = await inCompany(t.seed.a.companyId, (tx) => tx.select().from(customers));
    expect(rows.length).toBe(1);
  });

  test('eight at once: one winner, seven 409s, one stored customer', async () => {
    const owner = await agentFor('owner');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        owner.post('/api/customers').send({ displayName: `Racer ${i}`, phones: [{ number: '(402) 555-0178' }] }),
      ),
    );
    expect(results.filter((r) => r.status === 201).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(7);
    expect((await inCompany(t.seed.a.companyId, (tx) => tx.select().from(customers))).length).toBe(1);
  });

  test('simultaneous creates with overlapping numbers in a different order do not deadlock', async () => {
    const owner = await agentFor('owner');
    const a = '(402) 555-0181';
    const b = '(402) 555-0182';
    const results = await Promise.all([
      owner.post('/api/customers').send({ displayName: 'AB', phones: [{ number: a }, { number: b }] }),
      owner.post('/api/customers').send({ displayName: 'BA', phones: [{ number: b }, { number: a }] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('validation', () => {
  test.each([
    [{}, 'displayName', NAME_MESSAGE],
    [{ displayName: '   ' }, 'displayName', NAME_MESSAGE],
    [{ displayName: 42 }, 'displayName', NAME_MESSAGE],
    [{ displayName: 'x'.repeat(201) }, 'displayName', 'That is too long.'],
    [{ displayName: 'x', emails: ['nope'] }, 'emails.0', EMAIL_MESSAGE],
    [{ displayName: 'x', emails: 'a@b.co' }, 'emails', CHECK_FIELD],
    [{ displayName: 'x', phones: '4025550144' }, 'phones', CHECK_FIELD],
    [{ displayName: 'x', phones: [{ label: 'home' }] }, 'phones.0.number', BAD_PHONE],
    [{ displayName: 'x', phones: [{ number: MOLLY, primary: 'yes' }] }, 'phones.0.primary', CHECK_FIELD],
    [{ displayName: 'x', tags: [''] }, 'tags.0', CHECK_FIELD],
    [{ displayName: 'x', doNotContact: 'yes' }, 'doNotContact', CHECK_FIELD],
    [{ displayName: 'x', smsConsentStatus: 'maybe' }, 'smsConsentStatus', CHECK_FIELD],
    [{ displayName: 'x', source: 'import' }, 'source', CHECK_FIELD],
    [{ displayName: 'x', createdByUserId: NO_UUID }, 'createdByUserId', CHECK_FIELD],
  ])('POST %j → 400 on %s', async (body, field, message) => {
    const res = await (await agentFor('owner')).post('/api/customers').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message, field });
  });

  test('"attested" can only come from an import → 400 on smsConsentStatus', async () => {
    const res = await (await agentFor('owner')).post('/api/customers').send({
      displayName: 'x',
      smsConsentStatus: 'attested',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: ATTESTED, field: 'smsConsentStatus' });
  });

  test('a consent note is limited to 500 characters and only goes with "written"', async () => {
    const owner = await agentFor('owner');
    const tooLong = await owner.post('/api/customers').send({
      displayName: 'x',
      smsConsentStatus: 'written',
      consentNote: 'n'.repeat(501),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.field).toBe('consentNote');
    const justRight = await owner.post('/api/customers').send({
      displayName: 'x',
      smsConsentStatus: 'written',
      consentNote: 'n'.repeat(500),
    });
    expect(justRight.status).toBe(201);

    const wrongStatus = await owner.post('/api/customers').send({
      displayName: 'y',
      smsConsentStatus: 'express',
      consentNote: 'a note',
    });
    expect(wrongStatus.status).toBe(400);
    expect(wrongStatus.body.field).toBe('consentNote');
    const noStatus = await owner.post('/api/customers').send({ displayName: 'z', consentNote: 'a note' });
    expect(noStatus.status).toBe(400);
    expect(noStatus.body.field).toBe('consentNote');
  });

  test('a NUL character in any text is a 400, not a server error', async () => {
    const owner = await agentFor('owner');
    for (const [body, field] of [
      [{ displayName: 'a\u0000b' }, 'displayName'],
      [{ displayName: 'x', firstName: 'a\u0000b' }, 'firstName'],
      [{ displayName: 'x', tags: ['a\u0000b'] }, 'tags.0'],
      [{ displayName: 'x', phones: [{ number: MOLLY, label: 'a\u0000b' }] }, 'phones.0.label'],
      [{ displayName: 'x', smsConsentStatus: 'written', consentNote: 'a\u0000b' }, 'consentNote'],
    ] as const) {
      const res = await owner.post('/api/customers').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.field).toBe(field);
    }
    const search = await owner.get('/api/customers?q=a%00b');
    expect(search.status).toBe(400);
    expect(search.body.field).toBe('q');
  });

  test('too many phones, emails or tags are refused', async () => {
    const owner = await agentFor('owner');
    const manyPhones = Array.from({ length: 11 }, (_, i) => ({ number: `(402) 555-01${String(i).padStart(2, '0')}` }));
    const res = await owner.post('/api/customers').send({ displayName: 'x', phones: manyPhones });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('phones');
    const tags = await owner.post('/api/customers').send({
      displayName: 'x',
      tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
    });
    expect(tags.status).toBe(400);
    expect(tags.body.field).toBe('tags');
  });

  test('a signed-out caller gets 401 on every customer route', async () => {
    for (const res of await Promise.all([
      request(t.app).get('/api/customers'),
      request(t.app).post('/api/customers').send({ displayName: 'x' }),
      request(t.app).get(`/api/customers/${NO_UUID}`),
      request(t.app).patch(`/api/customers/${NO_UUID}`).send({ displayName: 'x' }),
      request(t.app).post(`/api/customers/${NO_UUID}/archive`),
      request(t.app).get('/api/activities'),
    ])) {
      expect(res.status).toBe(401);
    }
  });
});

describe('reading customers', () => {
  test('GET /api/customers/:id returns the same shape; a made-up or malformed id is 404', async () => {
    const made = await create('owner', { displayName: 'Molly Lindgren', phones: [{ number: MOLLY }] });
    const owner = await agentFor('owner');
    const res = await owner.get(`/api/customers/${made.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(made);

    for (const id of [NO_UUID, 'not-a-uuid']) {
      const missing = await owner.get(`/api/customers/${id}`);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: NOT_FOUND });
    }
  });

  test('the list is {customers, total}, ordered by name', async () => {
    await create('owner', { displayName: 'bob' });
    await create('owner', { displayName: 'Carol' });
    await create('owner', { displayName: 'Alice' });
    const res = await (await agentFor('office')).get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(names(res)).toEqual(['Alice', 'bob', 'Carol']);
  });

  test('limit and offset page through the list; total is the whole count', async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) await create('owner', { displayName: name });
    const owner = await agentFor('owner');
    const page = await owner.get('/api/customers?limit=2&offset=1');
    expect(names(page)).toEqual(['B', 'C']);
    expect(page.body.total).toBe(5);
    const past = await owner.get('/api/customers?offset=10');
    expect(past.body).toEqual({ customers: [], total: 5 });
  });

  test.each([['limit=0'], ['limit=-1'], ['limit=abc'], ['limit=1.5'], ['limit=1&limit=2']])('?%s → 400 on limit', async (query) => {
    const res = await (await agentFor('owner')).get(`/api/customers?${query}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NOT_A_NUMBER, field: 'limit' });
  });

  test('offset must be a whole number from 0 up; includeArchived must be true or false', async () => {
    const owner = await agentFor('owner');
    const offset = await owner.get('/api/customers?offset=-1');
    expect(offset.status).toBe(400);
    expect(offset.body.field).toBe('offset');
    const flag = await owner.get('/api/customers?includeArchived=maybe');
    expect(flag.status).toBe(400);
    expect(flag.body.field).toBe('includeArchived');
  });

  test('a limit above 200 is capped at 200, not refused', async () => {
    await create('owner', { displayName: 'Only one' });
    const res = await (await agentFor('owner')).get('/api/customers?limit=5000');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  test('another company never sees these customers: list, get, patch, archive and activities are all 404/empty', async () => {
    const mine = await create('owner', { displayName: 'Acme only', phones: [{ number: MOLLY }] });
    const bolt = await agentFor('owner', 'b');
    expect((await bolt.get('/api/customers')).body).toEqual({ customers: [], total: 0 });
    for (const res of await Promise.all([
      bolt.get(`/api/customers/${mine.id}`),
      bolt.patch(`/api/customers/${mine.id}`).send({ displayName: 'Hijack' }),
      bolt.post(`/api/customers/${mine.id}/archive`),
      bolt.post(`/api/customers/${mine.id}/unarchive`),
      bolt.get(`/api/activities?subjectType=customer&subjectId=${mine.id}`),
    ])) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
    expect((await dbCustomer(t.seed.a.companyId, mine.id)).displayName).toBe('Acme only');
  });
});

describe('search', () => {
  beforeEach(async () => {
    await create('owner', { displayName: 'Molly Lindgren', phones: [{ number: MOLLY }] });
    await create('owner', { displayName: 'Bob Smith', phones: [{ number: '(308) 555-0188' }] });
    await create('owner', { displayName: '100% Roofing LLC' });
    await create('owner', { displayName: 'A_B Supply' });
    await create('owner', { displayName: 'Axxb Supply' });
  });

  const search = async (q: string, extra = '') =>
    (await agentFor('owner')).get(`/api/customers?q=${encodeURIComponent(q)}${extra}`);

  test('q=lind matches "Molly Lindgren"; case does not matter; so does a name in the middle', async () => {
    expect(names(await search('lind'))).toEqual(['Molly Lindgren']);
    expect(names(await search('LIND'))).toEqual(['Molly Lindgren']);
    expect(names(await search('ollY LinD'))).toEqual(['Molly Lindgren']);
    expect((await search('lind')).body.total).toBe(1);
  });

  test('digits match any phone, however the query is punctuated', async () => {
    expect(names(await search('555-0144'))).toEqual(['Molly Lindgren']);
    expect(names(await search('(402) 555'))).toEqual(['Molly Lindgren']);
    expect(names(await search('+1 308'))).toEqual(['Bob Smith']);
    expect(names(await search('0188'))).toEqual(['Bob Smith']);
    expect(names(await search('555'))).toEqual(['Bob Smith', 'Molly Lindgren']);
  });

  test('fewer than three digits is not a phone search', async () => {
    expect(names(await search('14'))).toEqual([]);
    expect(names(await search('55'))).toEqual([]);
  });

  test('a name search also matches digits in a name', async () => {
    expect(names(await search('100'))).toEqual(['100% Roofing LLC']);
  });

  test('% and _ in the search are plain characters, not wildcards', async () => {
    expect(names(await search('%'))).toEqual(['100% Roofing LLC']);
    expect(names(await search('_'))).toEqual(['A_B Supply']);
    expect(names(await search('a_b'))).toEqual(['A_B Supply']);
    expect(names(await search('\\'))).toEqual([]);
  });

  test('a blank q lists everything', async () => {
    expect((await search('   ')).body.total).toBe(5);
  });

  test('a very long q is refused', async () => {
    const res = await search('x'.repeat(101));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('q');
  });

  test('archived customers stay out of the results unless asked for', async () => {
    const molly = (await search('lind')).body.customers[0] as { id: string };
    await (await agentFor('owner')).post(`/api/customers/${molly.id}/archive`);
    expect(names(await search('lind'))).toEqual([]);
    expect(names(await search('555-0144'))).toEqual([]);
    expect(names(await search('lind', '&includeArchived=true'))).toEqual(['Molly Lindgren']);
  });
});

describe('archiving', () => {
  test('archived customers are hidden from the list unless includeArchived=true', async () => {
    const keep = await create('owner', { displayName: 'Keep' });
    const gone = await create('owner', { displayName: 'Gone' });
    const owner = await agentFor('owner');

    t.clock.set(new Date('2026-10-13T09:00:00.000Z'));
    const archived = await owner.post(`/api/customers/${gone.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toBe('2026-10-13T09:00:00.000Z');

    const plain = await owner.get('/api/customers');
    expect(ids(plain.body.customers)).toEqual([keep.id]);
    expect(plain.body.total).toBe(1);
    const all = await owner.get('/api/customers?includeArchived=true');
    expect(all.body.total).toBe(2);
    expect(ids(all.body.customers).sort()).toEqual([keep.id, gone.id].sort());
    expect((await owner.get('/api/customers?includeArchived=false')).body.total).toBe(1);

    // An archived customer can still be opened by id, so a link to it keeps working.
    expect((await owner.get(`/api/customers/${gone.id}`)).body.archivedAt).toBe('2026-10-13T09:00:00.000Z');
  });

  test('unarchive brings it back; archiving twice changes nothing and logs nothing new', async () => {
    const made = await create('owner', { displayName: 'Round trip' });
    const owner = await agentFor('owner');

    t.clock.set(new Date('2026-10-13T09:00:00.000Z'));
    await owner.post(`/api/customers/${made.id}/archive`);
    t.clock.set(new Date('2026-10-13T10:00:00.000Z'));
    const again = await owner.post(`/api/customers/${made.id}/archive`);
    expect(again.status).toBe(200);
    expect(again.body.archivedAt).toBe('2026-10-13T09:00:00.000Z');
    expect((await dbAudit(t.seed.a.companyId, 'customer.archive')).length).toBe(1);

    const back = await owner.post(`/api/customers/${made.id}/unarchive`);
    expect(back.status).toBe(200);
    expect(back.body.archivedAt).toBeNull();
    expect((await owner.get('/api/customers')).body.total).toBe(1);
    const unchanged = await owner.post(`/api/customers/${made.id}/unarchive`);
    expect(unchanged.status).toBe(200);
    expect((await dbAudit(t.seed.a.companyId, 'customer.unarchive')).length).toBe(1);
  });

  test('unarchiving into a number someone else now holds is a 409 on that phone', async () => {
    const first = await create('owner', {
      displayName: 'Original',
      phones: [{ number: '(402) 555-0102' }, { number: MOLLY }],
    });
    const owner = await agentFor('owner');
    await owner.post(`/api/customers/${first.id}/archive`);
    await create('owner', { displayName: 'New holder', phones: [{ number: MOLLY }] });

    const res = await owner.post(`/api/customers/${first.id}/unarchive`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: TAKEN, field: 'phones.1.number' });
    expect((await dbCustomer(t.seed.a.companyId, first.id)).archivedAt).not.toBeNull();
  });

  test('archiving does not take the number off the opt-out list', async () => {
    const made = await create('owner', { displayName: 'DNC', doNotContact: true, phones: [{ number: MOLLY }] });
    await (await agentFor('owner')).post(`/api/customers/${made.id}/archive`);
    expect((await dbOptOuts(t.seed.a.companyId)).map((r) => r.phoneE164)).toEqual([MOLLY_E164]);
  });
});

describe('editing a customer', () => {
  test('PATCH changes only the fields sent and answers with the customer', async () => {
    const made = await create('owner', {
      displayName: 'Molly Lindgren',
      firstName: 'Molly',
      phones: [{ number: MOLLY }],
      emails: ['molly@example.com'],
      tags: ['hail'],
    });
    t.clock.set(new Date('2026-10-13T08:00:00.000Z'));
    const res = await (await agentFor('office')).patch(`/api/customers/${made.id}`).send({
      displayName: 'Molly L.',
      lastName: 'Lindgren',
      firstName: null,
      tags: ['vip', 'vip', ' roofer '],
      emails: ['A@x.co', 'a@x.co'],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...made,
      displayName: 'Molly L.',
      firstName: null,
      lastName: 'Lindgren',
      tags: ['vip', 'roofer'],
      emails: ['a@x.co'],
      updatedAt: '2026-10-13T08:00:00.000Z',
    });
  });

  test('PATCH phones replaces the list: the new numbers are normalized, primary rules apply', async () => {
    const made = await create('owner', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    const res = await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({
      phones: [{ number: '308.555.0188', label: 'work' }, { number: MOLLY }],
    });
    expect(res.status).toBe(200);
    expect(res.body.phones).toEqual([
      { number: '+13085550188', label: 'work', primary: true },
      { number: MOLLY_E164, label: null, primary: false },
    ]);
    const cleared = await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({ phones: [] });
    expect(cleared.body.phones).toEqual([]);
  });

  test('PATCH phones: a bad number, a repeated number and a taken number name their place', async () => {
    const other = await create('owner', { displayName: 'Other', phones: [{ number: '(402) 555-0102' }] });
    const made = await create('owner', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    const owner = await agentFor('owner');

    const bad = await owner.patch(`/api/customers/${made.id}`).send({ phones: [{ number: '555-0144' }] });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: BAD_PHONE, field: 'phones.0.number' });

    const twice = await owner.patch(`/api/customers/${made.id}`).send({
      phones: [{ number: MOLLY }, { number: '402-555-0144' }],
    });
    expect(twice.status).toBe(400);
    expect(twice.body).toEqual({ error: LISTED_TWICE, field: 'phones.1.number' });

    const taken = await owner.patch(`/api/customers/${made.id}`).send({
      phones: [{ number: MOLLY }, { number: '402 555 0102' }],
    });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: TAKEN, field: 'phones.1.number' });
    expect(other.id).not.toBe(made.id);
    expect((await dbCustomer(t.seed.a.companyId, made.id)).phones.map((p) => p.e164)).toEqual([MOLLY_E164]);
  });

  test("sending back a customer's own numbers is not a duplicate", async () => {
    const made = await create('owner', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    const res = await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({
      displayName: 'Molly L.',
      phones: [{ number: '402.555.0144', label: 'cell' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.phones).toEqual([{ number: MOLLY_E164, label: 'cell', primary: true }]);
  });

  test("an old shared number does not block unrelated edits to either customer", async () => {
    // Two customers that already share a number (made before the rule, or by an import).
    const a = await create('owner', { displayName: 'A', phones: [{ number: MOLLY }] });
    const b = await create('owner', { displayName: 'B' });
    await inCompany(t.seed.a.companyId, (tx) =>
      tx.update(customers).set({ phones: [{ e164: MOLLY_E164, primary: true }] }).where(eq(customers.id, b.id)),
    );
    const owner = await agentFor('owner');
    expect((await owner.patch(`/api/customers/${a.id}`).send({ phones: [{ number: MOLLY }], tags: ['x'] })).status).toBe(200);
    expect((await owner.patch(`/api/customers/${b.id}`).send({ displayName: 'B2' })).status).toBe(200);
  });

  test.each([
    [{}, undefined, NOTHING],
    [{ id: NO_UUID }, 'id', CHECK_FIELD],
    [{ source: 'import' }, 'source', CHECK_FIELD],
    [{ createdByUserId: NO_UUID }, 'createdByUserId', CHECK_FIELD],
    [{ archivedAt: null }, 'archivedAt', CHECK_FIELD],
    [{ companyId: NO_UUID }, 'companyId', CHECK_FIELD],
    [{ displayName: '' }, 'displayName', NAME_MESSAGE],
    [{ displayName: null }, 'displayName', NAME_MESSAGE],
    [{ emails: ['x'] }, 'emails.0', EMAIL_MESSAGE],
    [{ smsConsentStatus: 'attested' }, 'smsConsentStatus', ATTESTED],
    [{ smsConsentStatus: 'nope' }, 'smsConsentStatus', CHECK_FIELD],
    [{ consentNote: 'a note' }, 'consentNote', NOTE_MESSAGE],
  ])('PATCH %j → 400', async (body, field, message) => {
    const made = await create('owner', { displayName: 'Molly' });
    const res = await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(field === undefined ? { error: message } : { error: message, field });
  });

  test('PATCH on a missing or malformed id is 404, after the permission check', async () => {
    const owner = await agentFor('owner');
    expect((await owner.patch(`/api/customers/${NO_UUID}`).send({ displayName: 'x' })).status).toBe(404);
    expect((await owner.patch('/api/customers/nope').send({ displayName: 'x' })).status).toBe(404);
    const rep = await agentFor('rep');
    const forbidden = await rep.patch(`/api/customers/${NO_UUID}`).send({ doNotContact: true });
    expect(forbidden.status).toBe(403);
  });
});

describe('consent changes', () => {
  test('a rep sending smsConsentStatus or doNotContact on PATCH → 403, even for their own customer', async () => {
    const mine = await create('rep', { displayName: 'Rep customer', phones: [{ number: MOLLY }] });
    const rep = await agentFor('rep');
    for (const body of [
      { smsConsentStatus: 'express' },
      { smsConsentStatus: 'attested' },
      { smsConsentStatus: 'bogus' },
      { doNotContact: true },
      { doNotContact: false },
      { displayName: 'Renamed', doNotContact: true },
      { smsConsentStatus: 'written', consentNote: 'text' },
    ]) {
      const res = await rep.patch(`/api/customers/${mine.id}`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body).toEqual({ error: NOT_ALLOWED });
    }
    const stored = await dbCustomer(t.seed.a.companyId, mine.id);
    expect(stored.displayName).toBe('Rep customer');
    expect(stored.smsConsentStatus).toBe('none');
    expect(stored.doNotContact).toBe(false);
    expect(await dbOptOuts(t.seed.a.companyId)).toEqual([]);
  });

  test('a rep can still edit the other details of their own customer', async () => {
    const mine = await create('rep', { displayName: 'Rep customer' });
    const res = await (await agentFor('rep')).patch(`/api/customers/${mine.id}`).send({ displayName: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Renamed');
  });

  test.each(['owner', 'office'] as const)('%s may set consent: a manual change by that person, now', async (who) => {
    const made = await create('rep', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    t.clock.set(new Date('2026-10-14T12:00:00.000Z'));
    const res = await (await agentFor(who)).patch(`/api/customers/${made.id}`).send({ smsConsentStatus: 'express' });
    expect(res.status).toBe(200);
    expect(res.body.smsConsent).toEqual({ status: 'express', source: 'manual', at: '2026-10-14T12:00:00.000Z' });
    const stored = await dbCustomer(t.seed.a.companyId, made.id);
    expect(stored.smsConsentSource).toBe('manual');
    expect(stored.smsConsentByUserId).toBe(userOf(who).userId);
    expect(stored.smsConsentAt).toEqual(new Date('2026-10-14T12:00:00.000Z'));
    expect(stored.smsConsentEvidence).toBeNull();
  });

  test('"attested" is refused even for the owner, and nothing changes', async () => {
    const made = await create('owner', { displayName: 'Molly' });
    const res = await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({ smsConsentStatus: 'attested' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: ATTESTED, field: 'smsConsentStatus' });
    expect((await dbCustomer(t.seed.a.companyId, made.id)).smsConsentStatus).toBe('none');
  });

  test('"written" keeps the note in the evidence; a note needs "written"', async () => {
    const made = await create('owner', { displayName: 'Molly' });
    const owner = await agentFor('owner');
    const res = await owner.patch(`/api/customers/${made.id}`).send({
      smsConsentStatus: 'written',
      consentNote: 'Signed the offers form on 10/12',
    });
    expect(res.status).toBe(200);
    expect(res.body.smsConsent.status).toBe('written');
    expect((await dbCustomer(t.seed.a.companyId, made.id)).smsConsentEvidence).toEqual({
      note: 'Signed the offers form on 10/12',
    });

    const wrong = await owner.patch(`/api/customers/${made.id}`).send({ smsConsentStatus: 'express', consentNote: 'x' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.field).toBe('consentNote');
    const long = await owner.patch(`/api/customers/${made.id}`).send({
      smsConsentStatus: 'written',
      consentNote: 'n'.repeat(501),
    });
    expect(long.status).toBe(400);
    expect(long.body.field).toBe('consentNote');
  });

  test('setting the status it already has changes nothing: the first time stays on record', async () => {
    const made = await create('owner', { displayName: 'Molly' });
    const owner = await agentFor('owner');
    t.clock.set(new Date('2026-10-14T12:00:00.000Z'));
    await owner.patch(`/api/customers/${made.id}`).send({ smsConsentStatus: 'written', consentNote: 'first' });
    t.clock.set(new Date('2026-10-15T12:00:00.000Z'));
    const again = await (await agentFor('office'))
      .patch(`/api/customers/${made.id}`)
      .send({ smsConsentStatus: 'written', consentNote: 'second' });
    expect(again.status).toBe(200);
    expect(again.body.smsConsent.at).toBe('2026-10-14T12:00:00.000Z');
    const stored = await dbCustomer(t.seed.a.companyId, made.id);
    expect(stored.smsConsentByUserId).toBe(userOf('owner').userId);
    expect(stored.smsConsentEvidence).toEqual({ note: 'first' });
    const changed = (await dbActivities(t.seed.a.companyId, made.id)).filter((a) => a.kind === 'customer.consent_changed');
    expect(changed.length).toBe(1);
  });

  test('revoking keeps the evidence of the earlier consent', async () => {
    const made = await create('owner', {
      displayName: 'Molly',
      smsConsentStatus: 'written',
      consentNote: 'Signed the form',
    });
    const res = await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({ smsConsentStatus: 'revoked' });
    expect(res.body.smsConsent.status).toBe('revoked');
    expect((await dbCustomer(t.seed.a.companyId, made.id)).smsConsentEvidence).toEqual({ note: 'Signed the form' });
  });
});

describe('opt-outs', () => {
  test('PATCH doNotContact: true → every phone is on the opt-out list (keyword manual, now)', async () => {
    const made = await create('owner', {
      displayName: 'Molly',
      phones: [{ number: MOLLY }, { number: '(308) 555-0188' }],
    });
    expect(await dbOptOuts(t.seed.a.companyId)).toEqual([]);

    t.clock.set(new Date('2026-10-14T12:00:00.000Z'));
    const res = await (await agentFor('office')).patch(`/api/customers/${made.id}`).send({ doNotContact: true });
    expect(res.status).toBe(200);
    expect(res.body.doNotContact).toBe(true);
    const rows = await dbOptOuts(t.seed.a.companyId);
    expect(rows.map((r) => [r.companyId, r.phoneE164, r.keyword, r.at.toISOString()])).toEqual([
      [t.seed.a.companyId, '+13085550188', 'manual', '2026-10-14T12:00:00.000Z'],
      [t.seed.a.companyId, MOLLY_E164, 'manual', '2026-10-14T12:00:00.000Z'],
    ]);
  });

  test('PATCH smsConsentStatus: revoked → the same', async () => {
    const made = await create('owner', {
      displayName: 'Molly',
      phones: [{ number: MOLLY }, { number: '(308) 555-0188' }],
    });
    const res = await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({ smsConsentStatus: 'revoked' });
    expect(res.status).toBe(200);
    expect((await dbOptOuts(t.seed.a.companyId)).map((r) => [r.phoneE164, r.keyword])).toEqual([
      ['+13085550188', 'manual'],
      [MOLLY_E164, 'manual'],
    ]);
  });

  test('other statuses do not touch the list', async () => {
    const made = await create('owner', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    for (const status of ['express', 'written', 'none']) {
      await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({ smsConsentStatus: status });
    }
    expect(await dbOptOuts(t.seed.a.companyId)).toEqual([]);
  });

  test('a number added later to a do-not-contact (or revoked) customer is opted out too', async () => {
    const dnc = await create('owner', { displayName: 'DNC', doNotContact: true, phones: [{ number: MOLLY }] });
    const revoked = await create('owner', {
      displayName: 'Revoked',
      smsConsentStatus: 'revoked',
      phones: [{ number: '(308) 555-0188' }],
    });
    const owner = await agentFor('owner');
    // Both may be edited by the office, and by a rep for details: the rule follows the customer's state.
    await (await agentFor('office')).patch(`/api/customers/${dnc.id}`).send({
      phones: [{ number: MOLLY }, { number: '(402) 555-0102' }],
    });
    await owner.patch(`/api/customers/${revoked.id}`).send({
      phones: [{ number: '(308) 555-0188' }, { number: '(308) 555-0199' }],
    });
    expect((await dbOptOuts(t.seed.a.companyId)).map((r) => r.phoneE164)).toEqual([
      '+13085550188',
      '+13085550199',
      '+14025550102',
      MOLLY_E164,
    ]);
  });

  test('a rep adding a number to a do-not-contact customer they created also opts it out', async () => {
    const mine = await create('rep', { displayName: 'Rep customer', phones: [{ number: MOLLY }] });
    await (await agentFor('owner')).patch(`/api/customers/${mine.id}`).send({ doNotContact: true });
    const res = await (await agentFor('rep'))
      .patch(`/api/customers/${mine.id}`)
      .send({ phones: [{ number: MOLLY }, { number: '(402) 555-0102' }] });
    expect(res.status).toBe(200);
    expect((await dbOptOuts(t.seed.a.companyId)).map((r) => r.phoneE164)).toEqual(['+14025550102', MOLLY_E164]);
  });

  test('clearing do-not-contact does NOT take anyone off the list', async () => {
    const made = await create('owner', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    const owner = await agentFor('owner');
    await owner.patch(`/api/customers/${made.id}`).send({ doNotContact: true });
    const cleared = await owner.patch(`/api/customers/${made.id}`).send({ doNotContact: false });
    expect(cleared.status).toBe(200);
    expect(cleared.body.doNotContact).toBe(false);
    expect((await dbOptOuts(t.seed.a.companyId)).map((r) => r.phoneE164)).toEqual([MOLLY_E164]);
    // ... and moving the status off "revoked" leaves it alone as well.
    await owner.patch(`/api/customers/${made.id}`).send({ smsConsentStatus: 'revoked' });
    await owner.patch(`/api/customers/${made.id}`).send({ smsConsentStatus: 'express' });
    expect((await dbOptOuts(t.seed.a.companyId)).map((r) => r.phoneE164)).toEqual([MOLLY_E164]);
  });

  test("an earlier STOP from the customer is kept as it was; it is not rewritten as 'manual'", async () => {
    const made = await create('owner', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    const earlier = new Date('2026-10-01T10:00:00.000Z');
    await inCompany(t.seed.a.companyId, (tx) =>
      tx.insert(optOuts).values({ companyId: t.seed.a.companyId, phoneE164: MOLLY_E164, keyword: 'STOP', at: earlier }),
    );
    await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({ doNotContact: true });
    const rows = await dbOptOuts(t.seed.a.companyId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ phoneE164: MOLLY_E164, keyword: 'STOP', at: earlier });
  });

  test("another company's opt-outs are separate", async () => {
    const made = await create('owner', { displayName: 'Molly', phones: [{ number: MOLLY }], doNotContact: true });
    expect(made.doNotContact).toBe(true);
    expect((await dbOptOuts(t.seed.a.companyId)).length).toBe(1);
    expect(await dbOptOuts(t.seed.b.companyId)).toEqual([]);
  });
});

describe('history: audit log and activities', () => {
  test('PATCH writes an audit row with before and after, and an activity "Customer details updated"', async () => {
    const made = await create('owner', { displayName: 'Molly Lindgren', tags: ['hail'] });
    t.clock.set(new Date('2026-10-14T12:00:00.000Z'));
    const res = await (await agentFor('office')).patch(`/api/customers/${made.id}`).send({
      displayName: 'Molly L.',
      tags: ['hail', 'vip'],
    });
    expect(res.status).toBe(200);

    const rows = await dbAudit(t.seed.a.companyId, 'customer.update');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      companyId: t.seed.a.companyId,
      actorUserId: userOf('office').userId,
      action: 'customer.update',
      targetType: 'customer',
      targetId: made.id,
      before: { displayName: 'Molly Lindgren', tags: ['hail'] },
      after: { displayName: 'Molly L.', tags: ['hail', 'vip'] },
      at: new Date('2026-10-14T12:00:00.000Z'),
    });

    const acts = (await dbActivities(t.seed.a.companyId, made.id)).filter((a) => a.kind === 'customer.updated');
    expect(acts.length).toBe(1);
    expect(acts[0]).toMatchObject({
      subjectType: 'customer',
      summary: 'Customer details updated',
      actorType: 'user',
      actorUserId: userOf('office').userId,
      at: new Date('2026-10-14T12:00:00.000Z'),
    });
  });

  test('the audit row of a consent change shows the consent columns before and after', async () => {
    const made = await create('owner', { displayName: 'Molly' });
    t.clock.set(new Date('2026-10-14T12:00:00.000Z'));
    await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({
      smsConsentStatus: 'written',
      consentNote: 'Signed',
      doNotContact: false,
    });
    const [row] = await dbAudit(t.seed.a.companyId, 'customer.update');
    expect(row!.before).toEqual({
      smsConsentStatus: 'none',
      smsConsentSource: null,
      smsConsentAt: null,
      smsConsentByUserId: null,
      smsConsentEvidence: null,
      doNotContact: false,
    });
    expect(row!.after).toEqual({
      smsConsentStatus: 'written',
      smsConsentSource: 'manual',
      smsConsentAt: '2026-10-14T12:00:00.000Z',
      smsConsentByUserId: userOf('owner').userId,
      smsConsentEvidence: { note: 'Signed' },
      doNotContact: false,
    });
  });

  test('every customer PATCH is audited, even one that changes nothing', async () => {
    const made = await create('owner', { displayName: 'Molly' });
    const res = await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({ displayName: 'Molly' });
    expect(res.status).toBe(200);
    const [row] = await dbAudit(t.seed.a.companyId, 'customer.update');
    expect(row!.before).toEqual({ displayName: 'Molly' });
    expect(row!.after).toEqual({ displayName: 'Molly' });
  });

  test('a refused PATCH writes no audit row and no activity', async () => {
    const made = await create('owner', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    await create('owner', { displayName: 'Other', phones: [{ number: '(402) 555-0102' }] });
    await (await agentFor('owner')).patch(`/api/customers/${made.id}`).send({
      displayName: 'Changed',
      phones: [{ number: '(402) 555-0102' }],
    });
    expect(await dbAudit(t.seed.a.companyId, 'customer.update')).toEqual([]);
    expect((await dbCustomer(t.seed.a.companyId, made.id)).displayName).toBe('Molly');
    expect((await dbActivities(t.seed.a.companyId, made.id)).map((a) => a.kind)).toEqual(['customer.created']);
  });

  test('create is audited and logged as "Customer added"', async () => {
    t.clock.set(new Date('2026-10-14T12:00:00.000Z'));
    const made = await create('rep', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    const [audited] = await dbAudit(t.seed.a.companyId, 'customer.create');
    expect(audited).toMatchObject({ targetType: 'customer', targetId: made.id, actorUserId: userOf('rep').userId });
    expect(audited!.after).toMatchObject({ displayName: 'Molly', phones: [{ e164: MOLLY_E164, primary: true }] });
    const acts = await dbActivities(t.seed.a.companyId, made.id);
    expect(acts.map((a) => [a.kind, a.summary, a.actorType, a.actorUserId])).toEqual([
      ['customer.created', 'Customer added', 'user', userOf('rep').userId],
    ]);
  });

  test.each([
    ['none', 'not asked'],
    ['express', 'OK for updates'],
    ['written', 'OK for offers'],
    ['revoked', 'said no'],
  ])('a consent change to %s is logged as "Texting consent changed to %s"', async (status, label) => {
    const made = await create('owner', { displayName: 'Molly', smsConsentStatus: status === 'express' ? 'written' : 'express' });
    await (await agentFor('office')).patch(`/api/customers/${made.id}`).send({ smsConsentStatus: status });
    const consent = (await dbActivities(t.seed.a.companyId, made.id)).filter(
      (a) => a.kind === 'customer.consent_changed' && a.summary === `Texting consent changed to ${label}`,
    );
    expect(consent.length).toBe(1);
    expect(consent[0]).toMatchObject({ actorType: 'user', actorUserId: userOf('office').userId, subjectType: 'customer' });
    expect(consent[0]!.data).toMatchObject({ to: status });
  });

  test('turning do-not-contact on and off is logged', async () => {
    const made = await create('owner', { displayName: 'Molly' });
    const owner = await agentFor('owner');
    await owner.patch(`/api/customers/${made.id}`).send({ doNotContact: true });
    await owner.patch(`/api/customers/${made.id}`).send({ doNotContact: false });
    await owner.patch(`/api/customers/${made.id}`).send({ doNotContact: false });
    const summaries = (await dbActivities(t.seed.a.companyId, made.id))
      .filter((a) => a.kind === 'customer.consent_changed')
      .map((a) => a.summary)
      .sort();
    expect(summaries).toEqual(['Do not contact removed', 'Marked as do not contact']);
  });

  test('archive and unarchive are logged and audited', async () => {
    const made = await create('owner', { displayName: 'Molly' });
    const owner = await agentFor('owner');
    t.clock.set(new Date('2026-10-14T12:00:00.000Z'));
    await owner.post(`/api/customers/${made.id}/archive`);
    t.clock.set(new Date('2026-10-14T13:00:00.000Z'));
    await owner.post(`/api/customers/${made.id}/unarchive`);

    const acts = await dbActivities(t.seed.a.companyId, made.id);
    expect(acts.filter((a) => a.kind === 'customer.archived').map((a) => a.summary)).toEqual(['Customer archived']);
    expect(acts.filter((a) => a.kind === 'customer.unarchived').map((a) => a.summary)).toEqual(['Customer restored']);
    const [archived] = await dbAudit(t.seed.a.companyId, 'customer.archive');
    expect(archived).toMatchObject({
      targetId: made.id,
      before: { archivedAt: null },
      after: { archivedAt: '2026-10-14T12:00:00.000Z' },
    });
    const [restored] = await dbAudit(t.seed.a.companyId, 'customer.unarchive');
    expect(restored).toMatchObject({
      before: { archivedAt: '2026-10-14T12:00:00.000Z' },
      after: { archivedAt: null },
    });
  });

  test('GET /api/activities lists a customer\'s timeline, newest first', async () => {
    const made = await create('owner', { displayName: 'Molly', phones: [{ number: MOLLY }] });
    const owner = await agentFor('owner');
    t.clock.advance(60_000);
    await owner.patch(`/api/customers/${made.id}`).send({ displayName: 'Molly L.' });
    t.clock.advance(60_000);
    await owner.patch(`/api/customers/${made.id}`).send({ smsConsentStatus: 'revoked' });
    t.clock.advance(60_000);
    await owner.post(`/api/customers/${made.id}/archive`);

    const res = await owner.get(`/api/activities?subjectType=customer&subjectId=${made.id}`);
    expect(res.status).toBe(200);
    const list = res.body.activities as { kind: string; at: string }[];
    expect(res.body.total).toBe(list.length);
    expect(list.length).toBe(5);
    expect(list[0]!.kind).toBe('customer.archived');
    expect(list.at(-1)!.kind).toBe('customer.created');
    const times = list.map((a) => a.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(list.map((a) => a.kind).sort()).toEqual([
      'customer.archived',
      'customer.consent_changed',
      'customer.created',
      'customer.updated',
      'customer.updated',
    ]);
    expect(list[0]).toEqual({
      id: expect.any(String),
      subjectType: 'customer',
      subjectId: made.id,
      kind: 'customer.archived',
      summary: 'Customer archived',
      data: {},
      actorType: 'user',
      actorUserId: userOf('owner').userId,
      actorAgent: null,
      at: '2026-10-12T15:03:00.000Z',
    });
  });

  test('activities page with limit and offset, and ask for what they need', async () => {
    const made = await create('owner', { displayName: 'Molly' });
    const owner = await agentFor('owner');
    for (let i = 0; i < 3; i++) {
      t.clock.advance(1000);
      await owner.patch(`/api/customers/${made.id}`).send({ displayName: `Molly ${i}` });
    }
    const page = await owner.get(`/api/activities?subjectType=customer&subjectId=${made.id}&limit=2&offset=1`);
    expect(page.body.activities.length).toBe(2);
    expect(page.body.total).toBe(4);

    for (const [query, field] of [
      ['', 'subjectType'],
      ['subjectType=person&subjectId=' + made.id, 'subjectType'],
      ['subjectType=customer', 'subjectId'],
      ['subjectType=customer&subjectId=nope', 'subjectId'],
      [`subjectType=customer&subjectId=${made.id}&limit=0`, 'limit'],
    ] as const) {
      const res = await owner.get(`/api/activities?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.field, query).toBe(field);
    }
  });

  test('a customer that does not exist, or a job or property that does not, is 404', async () => {
    const owner = await agentFor('owner');
    for (const type of ['customer', 'property', 'job']) {
      const res = await owner.get(`/api/activities?subjectType=${type}&subjectId=${NO_UUID}`);
      expect(res.status, type).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
  });

  test('activities are stamped with the app clock', async () => {
    t.clock.set(new Date('2026-11-01T08:15:00.000Z'));
    const made = await create('owner', { displayName: 'Molly' });
    const [act] = await dbActivities(t.seed.a.companyId, made.id);
    expect(act!.at).toEqual(new Date('2026-11-01T08:15:00.000Z'));
    expect(
      (await inCompany(t.seed.a.companyId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, 'customer.create')))))[0]!.at,
    ).toEqual(new Date('2026-11-01T08:15:00.000Z'));
  });
});

describe('what a rep can see', () => {
  test("a rep lists, opens, edits and archives only the customers they made; everything else is 404", async () => {
    const mine = await create('rep', { displayName: 'Mine', phones: [{ number: '(402) 555-0101' }] });
    const theirs = await create('otherRep', { displayName: 'Theirs', phones: [{ number: '(402) 555-0102' }] });
    const owners = await create('owner', { displayName: "Owner's" });
    const rep = await agentFor('rep');

    const list = await rep.get('/api/customers');
    expect(ids(list.body.customers)).toEqual([mine.id]);
    expect(list.body.total).toBe(1);
    expect((await rep.get('/api/customers?q=Theirs')).body).toEqual({ customers: [], total: 0 });
    expect((await rep.get('/api/customers?q=555-0102')).body).toEqual({ customers: [], total: 0 });

    expect((await rep.get(`/api/customers/${mine.id}`)).status).toBe(200);
    for (const other of [theirs.id, owners.id]) {
      for (const res of await Promise.all([
        rep.get(`/api/customers/${other}`),
        rep.patch(`/api/customers/${other}`).send({ displayName: 'Mine now' }),
        rep.post(`/api/customers/${other}/archive`),
        rep.post(`/api/customers/${other}/unarchive`),
        rep.get(`/api/activities?subjectType=customer&subjectId=${other}`),
      ])) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: NOT_FOUND });
      }
    }
    expect((await rep.patch(`/api/customers/${mine.id}`).send({ displayName: 'Mine!' })).status).toBe(200);
    expect((await rep.post(`/api/customers/${mine.id}/archive`)).status).toBe(200);
    expect((await rep.get('/api/customers')).body.total).toBe(0);
    expect((await rep.get('/api/customers?includeArchived=true')).body.total).toBe(1);
    expect((await dbCustomer(t.seed.a.companyId, theirs.id)).displayName).toBe('Theirs');
  });

  test('the owner and the office see all of the company\'s customers, whoever made them', async () => {
    await create('rep', { displayName: 'From rep' });
    await create('otherRep', { displayName: 'From other rep' });
    await create('owner', { displayName: 'From owner' });
    for (const who of ['owner', 'office'] as const) {
      const res = await (await agentFor(who)).get('/api/customers');
      expect(names(res)).toEqual(['From other rep', 'From owner', 'From rep']);
      expect(res.body.total).toBe(3);
    }
  });

  test("the duplicate check looks at the whole company, not only the rep's own customers", async () => {
    await create('otherRep', { displayName: 'Theirs', phones: [{ number: MOLLY }] });
    const rep = await agentFor('rep');
    const res = await rep.post('/api/customers').send({ displayName: 'Mine', phones: [{ number: '402-555-0144' }] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: TAKEN, field: 'phones.0.number' });

    const mine = await create('rep', { displayName: 'Mine', phones: [{ number: '(402) 555-0102' }] });
    const clash = await rep.patch(`/api/customers/${mine.id}`).send({ phones: [{ number: MOLLY }] });
    expect(clash.status).toBe(409);
  });

  test("a rep reads the timeline of their own customer", async () => {
    const mine = await create('rep', { displayName: 'Mine' });
    const res = await (await agentFor('rep')).get(`/api/activities?subjectType=customer&subjectId=${mine.id}`);
    expect(res.status).toBe(200);
    expect(res.body.activities.map((a: { kind: string }) => a.kind)).toEqual(['customer.created']);
  });

  test('property and job timelines: the owner can open one that exists, a rep cannot yet, another company is 404', async () => {
    const customer = await create('owner', { displayName: 'Molly' });
    const { propertyId, jobId } = await inCompany(t.seed.a.companyId, async (tx) => {
      const [property] = await tx
        .insert(properties)
        .values({
          companyId: t.seed.a.companyId,
          customerId: customer.id,
          addressLine: '12 Oak St',
          city: 'Omaha',
          state: 'NE',
          zip: '68102',
          addressKey: '12 oak st|68102',
        })
        .returning({ id: properties.id });
      const [job] = await tx
        .insert(jobs)
        .values({ companyId: t.seed.a.companyId, customerId: customer.id, propertyId: property!.id })
        .returning({ id: jobs.id });
      return { propertyId: property!.id, jobId: job!.id };
    });
    const otherPropertyId = await inCompany(t.seed.b.companyId, async (tx) => {
      const [row] = await tx
        .insert(properties)
        .values({
          companyId: t.seed.b.companyId,
          addressLine: '9 Elm St',
          city: 'Omaha',
          state: 'NE',
          zip: '68102',
          addressKey: '9 elm st|68102',
        })
        .returning({ id: properties.id });
      return row!.id;
    });

    const owner = await agentFor('owner');
    for (const [type, id] of [['property', propertyId], ['job', jobId]] as const) {
      const res = await owner.get(`/api/activities?subjectType=${type}&subjectId=${id}`);
      expect(res.status, type).toBe(200);
      expect(res.body).toEqual({ activities: [], total: 0 });
    }
    expect((await owner.get(`/api/activities?subjectType=property&subjectId=${otherPropertyId}`)).status).toBe(404);
    expect((await owner.get(`/api/activities?subjectType=job&subjectId=${otherPropertyId}`)).status).toBe(404);

    const rep = await agentFor('rep');
    expect((await rep.get(`/api/activities?subjectType=property&subjectId=${propertyId}`)).status).toBe(404);
    expect((await rep.get(`/api/activities?subjectType=job&subjectId=${jobId}`)).status).toBe(404);
  });
});
