import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { candidateStormsForCompany } from '../src/repos/company-storms.ts';
import { stormLayer } from '../src/repos/storm-layer.ts';
import { createPools, type Pools } from '../src/pools.ts';
import { companiesWithCandidateStorms } from '../src/system/storm-match-fanout.ts';
import { type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { insertOmahaStorm, OMAHA_BOX, type Query, setFixtureServiceArea } from './fixtures/storms.ts';

const urls = inject('dbUrls');

let owner: pg.Pool;
let pools: Pools;
let seed: { a: SeededCompany; b: SeededCompany };

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pools, { companyId, userId: null, role: 'system', canApproveSpend: false }, fn);

const DAY = '2026-05-01';
const NOW = new Date('2026-05-02T12:00:00Z');

/** Two Omaha storms on one day; the second is marked as merged into the first. */
async function mergedPair(): Promise<{ survivor: string; merged: string }> {
  const survivor = await insertOmahaStorm(q, DAY);
  const merged = await insertOmahaStorm(q, DAY);
  await q('update storms set merged_into = $1 where id = $2', [survivor, merged]);
  return { survivor, merged };
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: urls.owner });
  pools = createPools({ tenant: urls.tenant, system: urls.system });
  await owner.query('select 1');
});

afterAll(async () => {
  await pools.end();
  await owner.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
  await setFixtureServiceArea(q, seed.a.companyId, OMAHA_BOX);
});

describe('merged storms', () => {
  test('merged storms are skipped by candidateStormsForCompany', async () => {
    const { survivor } = await mergedPair();
    await asCompany(seed.a.companyId, async (tx) => {
      const rows = await candidateStormsForCompany(tx, [DAY]);
      expect(rows.map((r) => r.id)).toEqual([survivor]);
    });
  });

  test('merged storms are skipped by companiesWithCandidateStorms', async () => {
    const survivor = await insertOmahaStorm(q, '2026-05-02');
    const merged = await insertOmahaStorm(q, DAY);
    await q('update storms set merged_into = $1 where id = $2', [survivor, merged]);
    expect(await companiesWithCandidateStorms(pools.system, { days: [DAY] })).toEqual([]);
    expect(await companiesWithCandidateStorms(pools.system, { days: ['2026-05-02'] })).toEqual([{ companyId: seed.a.companyId }]);
  });

  test('merged storms are skipped by stormLayer', async () => {
    const { survivor, merged } = await mergedPair();
    const layer = await asCompany(seed.a.companyId, (tx) =>
      stormLayer(tx, { bbox: [-96.2, 41.1, -95.8, 41.4], days: 14, zoom: 8, now: NOW }),
    );
    const ids = new Set(layer.swaths.features.map((f) => f.properties.stormId));
    expect(ids.has(survivor)).toBe(true);
    expect(ids.has(merged)).toBe(false);
    expect(ids.size).toBe(1);
  });

  test('merged_into must reference an existing storm', async () => {
    const storm = await insertOmahaStorm(q, DAY);
    await expect(owner.query('update storms set merged_into = gen_random_uuid() where id = $1', [storm])).rejects.toMatchObject({
      code: '23503',
    });
  });
});
