import { beforeEach, describe, expect, test } from 'vitest';
import { defaultPricebook } from '@roofline/shared';
import { Actors, dbAudit } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const AMOUNT = 'Enter an amount from 0 to 100,000.';
const CHECK_FIELD = 'Please check this field.';
const ROLE_CANNOT = "Your role can't do that. Ask the owner.";

const DEFAULTS = { wastePercent: 12, markupPercent: 25, taxPercent: 0, material: 'architectural' };

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
});

const A = () => t.seed.a.companyId;

/** The body a PUT needs: today's prices and defaults, as the owner sees them. */
async function currentBody() {
  const res = await (await who.as('owner')).get('/api/pricebook');
  expect(res.status).toBe(200);
  return { prices: { ...res.body.prices }, defaults: { ...res.body.defaults } };
}

describe('GET /api/pricebook', () => {
  test('a company with no saved pricebook sees v1 example prices and the default quote defaults', async () => {
    const res = await (await who.as('owner')).get('/api/pricebook');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ prices: defaultPricebook, defaults: DEFAULTS, isExample: true });
  });

  test('office can read the pricebook', async () => {
    const res = await (await who.as('office')).get('/api/pricebook');
    expect(res.status).toBe(200);
    expect(res.body.isExample).toBe(true);
  });

  test('a rep gets 403 on the pricebook', async () => {
    const res = await (await who.as('rep')).get('/api/pricebook');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(ROLE_CANNOT);
  });
});

describe('PUT /api/pricebook', () => {
  test('the owner saves a change, GET returns it as the company pricebook, and the change is audited', async () => {
    const owner = await who.as('owner');
    const body = await currentBody();
    const next = { ...body, prices: { ...body.prices, disposal: 500 } };

    const put = await owner.put('/api/pricebook').send(next);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ prices: next.prices, defaults: DEFAULTS, isExample: false });

    const get = await owner.get('/api/pricebook');
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ prices: next.prices, defaults: DEFAULTS, isExample: false });

    const audits = await dbAudit(t, A(), 'pricebook.updated');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ targetType: 'pricebook', targetId: A(), actorUserId: who.user('owner').userId });
  });

  test('office cannot save the pricebook (403)', async () => {
    const body = await currentBody();
    const res = await (await who.as('office')).put('/api/pricebook').send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(ROLE_CANNOT);
  });

  test('a rep cannot save the pricebook (403)', async () => {
    const body = await currentBody();
    const res = await (await who.as('rep')).put('/api/pricebook').send(body);
    expect(res.status).toBe(403);
  });

  test('a price above 100,000 is refused and names its field', async () => {
    const body = await currentBody();
    const res = await (await who.as('owner')).put('/api/pricebook').send({ ...body, prices: { ...body.prices, permit: 100001 } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: AMOUNT, field: 'prices.permit' });
  });

  test('a negative price is refused and names its field', async () => {
    const body = await currentBody();
    const res = await (await who.as('owner')).put('/api/pricebook').send({ ...body, prices: { ...body.prices, disposal: -1 } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: AMOUNT, field: 'prices.disposal' });
  });

  test('a price key the pricebook does not have is refused by name', async () => {
    const body = await currentBody();
    const res = await (await who.as('owner')).put('/api/pricebook').send({ ...body, prices: { ...body.prices, shingleDiscount: 5 } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: CHECK_FIELD, field: 'prices.shingleDiscount' });
  });

  test('a waste percent above 50 is refused and names its field', async () => {
    const body = await currentBody();
    const res = await (await who.as('owner')).put('/api/pricebook').send({ ...body, defaults: { ...body.defaults, wastePercent: 51 } });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('defaults.wastePercent');
  });

  test('a material that is not a shingle or metal option is refused', async () => {
    const body = await currentBody();
    const res = await (await who.as('owner')).put('/api/pricebook').send({ ...body, defaults: { ...body.defaults, material: 'slate' } });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('defaults.material');
  });
});

describe('company isolation', () => {
  test("company B's pricebook is not changed by company A's save", async () => {
    const body = await currentBody();
    const saved = await (await who.as('owner')).put('/api/pricebook').send({ ...body, prices: { ...body.prices, permit: 300 } });
    expect(saved.status).toBe(200);

    const bOwner = await who.as('owner', 'b');
    const res = await bOwner.get('/api/pricebook');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ prices: defaultPricebook, defaults: DEFAULTS, isExample: true });
  });
});
