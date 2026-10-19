import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { resolveCatalog, type WindowCatalog } from '@roofline/shared';
import { WINCHOICE_CATALOG } from '../src/scripts/demo-winchoice-catalog.ts';
import { Actors } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/* /api/window-catalog: the company's window choices, tier names, prices, adders and facts. */

const ROLE_CANNOT = "Your role can't do that. Ask the owner.";

let db: pg.Pool;
let t: TestApp;

beforeAll(() => {
  db = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await db.end();
});
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
});

const copy = (): WindowCatalog => JSON.parse(JSON.stringify(WINCHOICE_CATALOG)) as WindowCatalog;

describe('GET and PUT /api/window-catalog', () => {
  test('a company with nothing saved sees the defaults: four plain choices, Good / Better / Best, no facts', async () => {
    const res = await (await who.as('owner')).get('/api/window-catalog');
    expect(res.status).toBe(200);
    expect(res.body.catalog).toEqual(resolveCatalog(null));
    expect(res.body.catalog.styleTiles.map((x: { label: string }) => x.label)).toEqual(['Opens up and down', 'Slides sideways', "Doesn't open", 'Bay, bow or odd shape']);
  });

  test('the owner saves the whole catalog and GET returns it; the save is audited', async () => {
    const owner = await who.as('owner');
    const put = await owner.put('/api/window-catalog').send({ catalog: copy() });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.catalog).toEqual(copy());
    const get = await owner.get('/api/window-catalog');
    expect(get.body.catalog.tiers.map((x: { label: string }) => x.label)).toEqual(['Replenish', 'Refine', 'Renew']);
    expect(get.body.catalog.trust.badges).toEqual(['A+ BBB', 'Made in USA', 'Lifetime warranty available']);
    const audits = await db.query(`select 1 from audit_log where company_id = $1 and action = 'window_catalog.updated'`, [t.seed.a.companyId]);
    expect(audits.rowCount).toBe(1);
  });

  test('bad catalogs are refused and name their field', async () => {
    const owner = await who.as('owner');
    const send = (catalog: unknown) => owner.put('/api/window-catalog').send({ catalog });

    const emptyLabel = copy();
    emptyLabel.styleTiles[0]!.label = '';
    expect((await send(emptyLabel)).body.field).toBe('catalog.styleTiles.0.label');

    const fourBadges = copy();
    fourBadges.trust.badges = ['a', 'b', 'c', 'd'];
    expect((await send(fourBadges)).body.field).toBe('catalog.trust.badges');

    const insecure = copy();
    insecure.financing = { text: 'Financing', url: 'http://example.test' };
    expect((await send(insecure)).body.field).toBe('catalog.financing.url');

    const negative = copy();
    negative.tiers[0]!.priceCents.small = -1;
    expect((await send(negative)).status).toBe(400);

    const twice = copy();
    twice.styleTiles[1]!.styles = ['picture'];
    const res = await send(twice);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('catalog.styleTiles.2.styles');

    expect((await owner.put('/api/window-catalog').send({ catalog: copy(), extra: 1 })).status).toBe(400);
  });

  test('office can read but not save; a rep can do neither', async () => {
    const office = await who.as('office');
    expect((await office.get('/api/window-catalog')).status).toBe(200);
    const put = await office.put('/api/window-catalog').send({ catalog: copy() });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe(ROLE_CANNOT);
    const rep = await who.as('rep');
    expect((await rep.get('/api/window-catalog')).status).toBe(403);
    expect((await rep.put('/api/window-catalog').send({ catalog: copy() })).status).toBe(403);
  });

  test("company B never sees company A's catalog", async () => {
    expect((await (await who.as('owner')).put('/api/window-catalog').send({ catalog: copy() })).status).toBe(200);
    const res = await (await who.as('owner', 'b')).get('/api/window-catalog');
    expect(res.body.catalog).toEqual(resolveCatalog(null));
  });
});
