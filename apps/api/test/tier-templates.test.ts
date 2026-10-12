import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_TIER_TEMPLATES, type SetupView, type TierTemplate } from '@roofline/shared';
import { Actors } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const ROLE_CANNOT = "Your role can't do that. Ask the owner.";

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
});

const copy = (): TierTemplate[] => JSON.parse(JSON.stringify(DEFAULT_TIER_TEMPLATES)) as TierTemplate[];

describe('GET and PUT /api/tier-templates', () => {
  test('a company with nothing saved sees the three defaults', async () => {
    const res = await (await who.as('owner')).get('/api/tier-templates');
    expect(res.status).toBe(200);
    expect(res.body.templates).toEqual(DEFAULT_TIER_TEMPLATES);
    expect(res.body.templates.map((x: TierTemplate) => x.tier)).toEqual(['good', 'better', 'best']);
  });

  test('the owner saves changes and GET returns them', async () => {
    const owner = await who.as('owner');
    const templates = copy();
    templates[0]!.name = 'Basic shingles';
    templates[1]!.wastePercent = 15;
    templates[2]!.markupPercent = 30;
    const put = await owner.put('/api/tier-templates').send({ templates });
    expect(put.status).toBe(200);
    expect(put.body.templates).toEqual(templates);

    const get = await owner.get('/api/tier-templates');
    expect(get.status).toBe(200);
    expect(get.body.templates).toEqual(templates);
    expect(get.body.isDefault).toBe(false);
  });

  test('bad templates are refused and name their field', async () => {
    const owner = await who.as('owner');
    const send = (templates: unknown) => owner.put('/api/tier-templates').send({ templates });

    const emptyName = copy();
    emptyName[0]!.name = '';
    expect((await send(emptyName)).body.field).toBe('templates.0.name');

    const wasteHigh = copy();
    wasteHigh[2]!.wastePercent = 80;
    expect((await send(wasteHigh)).body.field).toBe('templates.2.wastePercent');

    const two = await send(copy().slice(0, 2));
    expect(two.status).toBe(400);
    expect(two.body.field).toBe('templates');

    const dup = copy();
    dup[2]!.tier = 'better';
    const dupRes = await send(dup);
    expect(dupRes.status).toBe(400);
    expect(dupRes.body.field).toBe('templates');

    const many = copy();
    many[1]!.highlights = ['a', 'b', 'c', 'd', 'e'];
    expect((await send(many)).body.field).toBe('templates.1.highlights');
  });

  test('office can read but not save; a rep can do neither', async () => {
    const office = await who.as('office');
    expect((await office.get('/api/tier-templates')).status).toBe(200);
    const put = await office.put('/api/tier-templates').send({ templates: copy() });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe(ROLE_CANNOT);

    const rep = await who.as('rep');
    expect((await rep.get('/api/tier-templates')).status).toBe(403);
    expect((await rep.put('/api/tier-templates').send({ templates: copy() })).status).toBe(403);
  });

  test("company B never sees company A's templates", async () => {
    const templates = copy();
    templates[0]!.name = 'Only for A';
    expect((await (await who.as('owner')).put('/api/tier-templates').send({ templates })).status).toBe(200);
    const res = await (await who.as('owner', 'b')).get('/api/tier-templates');
    expect(res.status).toBe(200);
    expect(res.body.templates).toEqual(DEFAULT_TIER_TEMPLATES);
  });
});

describe('/api/estimator/settings', () => {
  test('the owner sees the defaults', async () => {
    const res = await (await who.as('owner')).get('/api/estimator/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      defaultPitchX12: 6,
      overhangFt: 1,
      proposalValidDays: 30,
      aerialMeasure: false,
      aerialConfigured: t.deps.aerial.configured,
      estimateChangeClause: true,
      financingAprBps: null,
      financingTermMonths: null,
    });
  });

  test('a save is returned by the next GET', async () => {
    const owner = await who.as('owner');
    const put = await owner.put('/api/estimator/settings').send({ proposalValidDays: 45, financingAprBps: 999, financingTermMonths: 120 });
    expect(put.status).toBe(200);
    const get = await owner.get('/api/estimator/settings');
    expect(get.body).toMatchObject({ proposalValidDays: 45, financingAprBps: 999, financingTermMonths: 120, defaultPitchX12: 6 });
  });

  test('bad values are refused and name their field', async () => {
    const owner = await who.as('owner');
    const zero = await owner.put('/api/estimator/settings').send({ proposalValidDays: 0 });
    expect(zero.status).toBe(400);
    expect(zero.body.field).toBe('proposalValidDays');
    const alone = await owner.put('/api/estimator/settings').send({ financingAprBps: 999 });
    expect(alone.status).toBe(400);
    expect(alone.body.field).toBe('financingTermMonths');
    expect((await owner.put('/api/estimator/settings').send({})).status).toBe(400);
  });

  test('office reads but cannot save; a rep can do neither', async () => {
    const office = await who.as('office');
    expect((await office.get('/api/estimator/settings')).status).toBe(200);
    expect((await office.put('/api/estimator/settings').send({ proposalValidDays: 20 })).status).toBe(403);
    const rep = await who.as('rep');
    expect((await rep.get('/api/estimator/settings')).status).toBe(403);
  });
});

describe('setup item prices_and_tiers', () => {
  const state = async () => {
    const res = await (await who.as('owner')).get('/api/setup');
    expect(res.status).toBe(200);
    const row = (res.body as SetupView).items.find((i) => i.key === 'prices_and_tiers')!;
    return row;
  };

  test('is done only when both the pricebook and the tiers are saved', async () => {
    const owner = await who.as('owner');
    const before = await state();
    expect(before.status).toBe('todo');
    expect(before.comingWith).toBeNull();

    const book = await owner.get('/api/pricebook');
    expect((await owner.put('/api/pricebook').send({ prices: book.body.prices, defaults: book.body.defaults })).status).toBe(200);
    expect((await state()).status).toBe('todo');

    expect((await owner.put('/api/tier-templates').send({ templates: copy() })).status).toBe(200);
    expect((await state()).status).toBe('done');
  });

  test('tiers alone are not enough', async () => {
    const owner = await who.as('owner');
    expect((await owner.put('/api/tier-templates').send({ templates: copy() })).status).toBe(200);
    expect((await state()).status).toBe('todo');
  });
});
