import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_QUOTE_DEFAULTS } from '@roofline/db';
import { calculateQuote, defaultPricebook, defaultScope, type Pricebook } from '@roofline/shared';
import { Actors, addressFor, type CompanyKey, mustCreate, NO_UUID, NOT_FOUND, timeline } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
/** Thirty days after 2026-10-12 in America/Chicago. */
const VALID_UNTIL = '2026-11-11';
const FINAL_MESSAGE = 'This quote is final. Copy it to make changes.';
const AREA_MESSAGE = 'Please enter the roof area in square feet, from 1 to 100,000.';
const PITCH_MESSAGE = 'Please enter a pitch from 0 to 24.';
const NOT_ALLOWED_FIELD = 'Please check this field.';
const NOTHING = "There's nothing to change.";

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;
const B = () => t.seed.b.companyId;

/** v1's default roof, as a measurement. */
const MEASUREMENT = {
  source: 'manual',
  areaSqFt: defaultScope.areaSqFt,
  areaType: defaultScope.areaType,
  pitch: defaultScope.pitch,
  notes: null,
};

/** The total v1's default scope costs at the ported prices. Never typed as a literal. */
const DEFAULT_TOTAL = calculateQuote(defaultScope, defaultPricebook).totalCents;

/** A pricebook with one price changed, derived from the ported one. */
const CHANGED_PRICES: Pricebook = { ...defaultPricebook, disposal: defaultPricebook.disposal + 100 };

const DEFAULTS = {
  wastePercent: DEFAULT_QUOTE_DEFAULTS.wastePercent,
  markupPercent: DEFAULT_QUOTE_DEFAULTS.markupPercent,
  taxPercent: DEFAULT_QUOTE_DEFAULTS.taxPercent,
  material: DEFAULT_QUOTE_DEFAULTS.material,
};

/** A customer, a house and a job for them, made by the owner of `company` unless `extra` says otherwise. */
async function jobWith(n: number, extra: Record<string, unknown> = {}, company: CompanyKey = 'a') {
  const owner = await who.as('owner', company);
  const customer = await mustCreate(owner, '/api/customers', { displayName: `Quote Customer ${n}` });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(n) });
  const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id, ...extra });
  return { customer, property, job };
}

/** Creates a quote on a job as `agent`; the body is v1's default roof unless `body` says otherwise. */
const postQuote = (agent: SuperAgent, jobId: string, body: Record<string, unknown> = {}) =>
  agent.post(`/api/jobs/${jobId}/quotes`).send({ measurement: MEASUREMENT, ...body });

/** Creates a quote and returns its 201 body; fails the test on any other status. */
async function quoteOn(jobId: string, body: Record<string, unknown> = {}, company: CompanyKey = 'a') {
  const res = await postQuote(await who.as('owner', company), jobId, body);
  if (res.status !== 201) throw new Error(`quote create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; number: string; calculation: { totalCents: number }; prices: Pricebook };
}

/** The owner saves a pricebook with the disposal price changed. */
async function changePricebook(prices: Pricebook = CHANGED_PRICES) {
  const owner = await who.as('owner');
  const res = await owner.put('/api/pricebook').send({ prices, defaults: DEFAULTS });
  expect(res.status).toBe(200);
}

async function finalize(quoteId: string) {
  return (await who.as('owner')).post(`/api/quotes/${quoteId}/finalize`);
}

describe('creating a quote', () => {
  test('v1 default roof: 201, Q-0001, draft, the ported total, and the activity line on the job', async () => {
    const { job } = await jobWith(1);
    const res = await postQuote(await who.as('owner'), job.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      jobId: job.id,
      number: 'Q-0001',
      status: 'draft',
      measurement: MEASUREMENT,
      prices: defaultPricebook,
      notes: null,
      validUntil: VALID_UNTIL,
      finalizedAt: null,
      canEdit: true,
      calculation: { totalCents: DEFAULT_TOTAL },
      scope: {
        areaSqFt: defaultScope.areaSqFt,
        areaType: defaultScope.areaType,
        pitch: defaultScope.pitch,
      },
    });
    expect(res.body.scope).toEqual(defaultScope);
    expect((await timeline(t, A(), job.id)).map(([, summary]) => summary)).toContain('Quote Q-0001 started');
  });

  test('a scope given with the measurement fills the rest from the pricebook defaults; the area always comes from the measurement', async () => {
    const { job } = await jobWith(2);
    const res = await postQuote(await who.as('owner'), job.id, { scope: { ridgeFt: 40, areaSqFt: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.scope).toEqual({ ...defaultScope, ridgeFt: 40 });
    expect(res.body.calculation.totalCents).toBe(calculateQuote({ ...defaultScope, ridgeFt: 40 }, defaultPricebook).totalCents);
  });

  test('a bad area is refused with its field, and an unknown field is refused by name', async () => {
    const { job } = await jobWith(3);
    const owner = await who.as('owner');
    const area = await postQuote(owner, job.id, { measurement: { ...MEASUREMENT, areaSqFt: 0 } });
    expect(area.status).toBe(400);
    expect(area.body).toEqual({ error: AREA_MESSAGE, field: 'measurement.areaSqFt' });

    const pitch = await postQuote(owner, job.id, { measurement: { ...MEASUREMENT, pitch: 25 } });
    expect(pitch.status).toBe(400);
    expect(pitch.body).toEqual({ error: PITCH_MESSAGE, field: 'measurement.pitch' });

    const unknown = await postQuote(owner, job.id, { total: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: NOT_ALLOWED_FIELD, field: 'total' });
  });
});

describe('numbering', () => {
  test('quote numbers count up per company, and two creates at once get two different numbers', async () => {
    const first = await jobWith(10);
    const second = await jobWith(11);
    const third = await jobWith(12);
    const owner = await who.as('owner');
    expect((await postQuote(owner, first.job.id)).body.number).toBe('Q-0001');
    expect((await postQuote(owner, second.job.id)).body.number).toBe('Q-0002');

    const [x, y] = await Promise.all([
      postQuote(owner, third.job.id),
      postQuote(owner, first.job.id),
    ]);
    expect(x.status).toBe(201);
    expect(y.status).toBe(201);
    expect([x.body.number, y.body.number].sort()).toEqual(['Q-0003', 'Q-0004']);
  });

  test('company B starts its own numbers at Q-0001', async () => {
    const { job } = await jobWith(20, {}, 'b');
    const res = await postQuote(await who.as('owner', 'b'), job.id);
    expect(res.status).toBe(201);
    expect(res.body.number).toBe('Q-0001');
  });
});

describe('the pricebook and frozen quotes', () => {
  test('a final quote keeps its old prices after the pricebook changes; a new quote uses the new ones', async () => {
    const { job } = await jobWith(30);
    const old = await quoteOn(job.id);
    expect((await finalize(old.id)).status).toBe(200);

    await changePricebook();

    const still = await (await who.as('owner')).get(`/api/quotes/${old.id}`);
    expect(still.status).toBe(200);
    expect(still.body.status).toBe('final');
    expect(still.body.prices).toEqual(defaultPricebook);
    expect(still.body.calculation.totalCents).toBe(DEFAULT_TOTAL);

    const fresh = await quoteOn(job.id);
    expect(fresh.prices).toEqual(CHANGED_PRICES);
    expect(fresh.calculation.totalCents).toBe(calculateQuote(defaultScope, CHANGED_PRICES).totalCents);
    expect(fresh.calculation.totalCents).not.toBe(DEFAULT_TOTAL);
  });

  test('a copy of a quote is a new draft with today\'s prices and a new number', async () => {
    const { job } = await jobWith(31);
    const original = await quoteOn(job.id);
    await changePricebook();

    const res = await (await who.as('owner')).post(`/api/quotes/${original.id}/copy`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      number: 'Q-0002',
      status: 'draft',
      jobId: job.id,
      prices: CHANGED_PRICES,
      calculation: { totalCents: calculateQuote(defaultScope, CHANGED_PRICES).totalCents },
    });
    expect(res.body.id).not.toBe(original.id);
  });
});

describe('editing a quote', () => {
  test('a final quote cannot be patched: 409 with the plain sentence', async () => {
    const { job } = await jobWith(40);
    const quote = await quoteOn(job.id);
    expect((await finalize(quote.id)).status).toBe(200);

    const res = await (await who.as('owner')).patch(`/api/quotes/${quote.id}`).send({ notes: 'Too late' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: FINAL_MESSAGE });
  });

  test('a final quote cannot be finalized again: 409 with the same sentence', async () => {
    const { job } = await jobWith(41);
    const quote = await quoteOn(job.id);
    expect((await finalize(quote.id)).status).toBe(200);
    const again = await finalize(quote.id);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: FINAL_MESSAGE });
  });

  test('a draft takes notes and recomputes; a changed area changes the scope and total', async () => {
    const { job } = await jobWith(42);
    const quote = await quoteOn(job.id);
    const owner = await who.as('owner');

    const notes = await owner.patch(`/api/quotes/${quote.id}`).send({ notes: '  Ask about gutters  ' });
    expect(notes.status).toBe(200);
    expect(notes.body.notes).toBe('Ask about gutters');
    expect(notes.body.calculation.totalCents).toBe(DEFAULT_TOTAL);

    const bigger = await owner.patch(`/api/quotes/${quote.id}`).send({ measurement: { ...MEASUREMENT, areaSqFt: 3000 } });
    expect(bigger.status).toBe(200);
    expect(bigger.body.scope.areaSqFt).toBe(3000);
    expect(bigger.body.calculation.totalCents).toBe(calculateQuote({ ...defaultScope, areaSqFt: 3000 }, defaultPricebook).totalCents);
  });

  test('refreshPrices on a draft picks up the new prices; without it the draft keeps its own', async () => {
    const { job } = await jobWith(43);
    const quote = await quoteOn(job.id);
    await changePricebook();
    const owner = await who.as('owner');

    const kept = await owner.patch(`/api/quotes/${quote.id}`).send({ notes: 'Still old' });
    expect(kept.body.prices).toEqual(defaultPricebook);

    const refreshed = await owner.patch(`/api/quotes/${quote.id}`).send({ refreshPrices: true });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.prices).toEqual(CHANGED_PRICES);
    expect(refreshed.body.calculation.totalCents).toBe(calculateQuote(defaultScope, CHANGED_PRICES).totalCents);
  });

  test('an empty edit is refused', async () => {
    const { job } = await jobWith(44);
    const quote = await quoteOn(job.id);
    const res = await (await who.as('owner')).patch(`/api/quotes/${quote.id}`).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NOTHING });
  });
});

describe('finalizing a quote', () => {
  test('finalize sets the job value when it was empty, and says so on the job', async () => {
    const { job } = await jobWith(50);
    const quote = await quoteOn(job.id);
    const res = await finalize(quote.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: quote.id, number: 'Q-0001', status: 'final', canEdit: false });
    expect(res.body.finalizedAt).not.toBeNull();

    const after = await (await who.as('owner')).get(`/api/jobs/${job.id}`);
    expect(after.body.valueCents).toBe(DEFAULT_TOTAL);

    const lines = (await timeline(t, A(), job.id)).map(([, summary]) => summary);
    expect(lines).toContain('Value set from quote Q-0001');
    expect(lines).toContainEqual(expect.stringMatching(/^Quote Q-0001 marked final$/));
  });

  test('finalize leaves a job value that is already set', async () => {
    const { job } = await jobWith(51, { valueCents: 5000 });
    const quote = await quoteOn(job.id);
    expect((await finalize(quote.id)).status).toBe(200);

    const after = await (await who.as('owner')).get(`/api/jobs/${job.id}`);
    expect(after.body.valueCents).toBe(5000);
    const lines = (await timeline(t, A(), job.id)).map(([, summary]) => summary);
    expect(lines).not.toContain('Value set from quote Q-0001');
    expect(lines).toContainEqual(expect.stringMatching(/^Quote Q-0001 marked final/));
  });
});

describe('listing a job\'s quotes', () => {
  test('GET returns { quotes } newest first', async () => {
    const { job } = await jobWith(60);
    await quoteOn(job.id);
    t.clock.advance(60_000); // the second quote is later, so it is the newer one
    await quoteOn(job.id);

    const res = await (await who.as('owner')).get(`/api/jobs/${job.id}/quotes`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      quotes: [
        expect.objectContaining({ number: 'Q-0002', status: 'draft', totalCents: DEFAULT_TOTAL }),
        expect.objectContaining({ number: 'Q-0001', status: 'draft', totalCents: DEFAULT_TOTAL }),
      ],
    });
  });
});

describe('reps', () => {
  test('the assigned rep can create and read; a rep without the job gets 404 on every quote route', async () => {
    const repId = who.user('rep').userId;
    const { job } = await jobWith(70, { stage: 'inspection', assignedUserId: repId, valueCents: 100 });
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const other = await who.as('otherRep');

    const made = await postQuote(rep, job.id);
    expect(made.status).toBe(201);
    const quoteId: string = made.body.id;

    expect((await rep.get(`/api/jobs/${job.id}/quotes`)).status).toBe(200);
    expect((await rep.get(`/api/quotes/${quoteId}`)).status).toBe(200);

    const ownerQuote = await quoteOn(job.id);
    expect((await owner.get(`/api/quotes/${ownerQuote.id}`)).status).toBe(200);

    expect((await other.get(`/api/jobs/${job.id}/quotes`)).status).toBe(404);
    expect((await postQuote(other, job.id)).status).toBe(404);
    const hidden = await other.get(`/api/quotes/${quoteId}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: NOT_FOUND });
    expect((await other.patch(`/api/quotes/${quoteId}`).send({ notes: 'nope' })).status).toBe(404);
    expect((await other.post(`/api/quotes/${quoteId}/finalize`)).status).toBe(404);
    expect((await other.post(`/api/quotes/${quoteId}/copy`)).status).toBe(404);
  });
});

describe('reps and job value', () => {
  test('a rep who neither created nor is assigned an unassigned lead cannot see its quotes', async () => {
    const { job } = await jobWith(75); // an unassigned lead made by the owner
    const quote = await quoteOn(job.id);
    expect((await finalize(quote.id)).status).toBe(200);
    const rep = await who.as('rep');

    // The lead itself is visible to the rep, but its value, and so its quotes, are not.
    const view = await rep.get(`/api/jobs/${job.id}/view`);
    expect(view.status).toBe(200);
    expect(view.body.quotes).toEqual([]);

    const list = await rep.get(`/api/jobs/${job.id}/quotes`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ quotes: [] });

    const hidden = await rep.get(`/api/quotes/${quote.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: NOT_FOUND });
    expect((await rep.get(`/api/quotes/${quote.id}/pdf`)).status).toBe(404);
    expect((await postQuote(rep, job.id)).status).toBe(404);
  });
});

describe('company isolation', () => {
  test('company B\'s owner gets 404 for company A\'s job and quote ids', async () => {
    const { job } = await jobWith(80);
    const quote = await quoteOn(job.id);
    const intruder = await who.as('owner', 'b');

    expect((await intruder.get(`/api/jobs/${job.id}/quotes`)).status).toBe(404);
    expect((await postQuote(intruder, job.id)).status).toBe(404);
    expect((await intruder.get(`/api/quotes/${quote.id}`)).status).toBe(404);
    expect((await intruder.patch(`/api/quotes/${quote.id}`).send({ notes: 'x' })).status).toBe(404);
    expect((await intruder.post(`/api/quotes/${quote.id}/finalize`)).status).toBe(404);
    expect((await intruder.post(`/api/quotes/${quote.id}/copy`)).status).toBe(404);
    expect(B()).not.toBe(A());
  });
});

describe('ids that cannot be quotes or jobs', () => {
  test('a malformed id and the all-zero id are a plain 404', async () => {
    const owner = await who.as('owner');
    for (const bad of ['not-a-uuid', NO_UUID]) {
      const job = await owner.get(`/api/jobs/${bad}/quotes`);
      expect(job.status).toBe(404);
      expect(job.body).toEqual({ error: NOT_FOUND });
      expect((await postQuote(owner, bad)).status).toBe(404);
      expect((await owner.get(`/api/quotes/${bad}`)).status).toBe(404);
      expect((await owner.patch(`/api/quotes/${bad}`).send({ notes: 'x' })).status).toBe(404);
      expect((await owner.post(`/api/quotes/${bad}/finalize`)).status).toBe(404);
      expect((await owner.post(`/api/quotes/${bad}/copy`)).status).toBe(404);
    }
  });
});
