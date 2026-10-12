import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { companiesWithCandidateStorms } from '../src/system/storm-match-fanout.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { insertOmahaStorm, LINCOLN_BOX, OMAHA_BOX, type Query, setFixtureServiceArea } from './fixtures/storms.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });
const owner = new pg.Pool({ connectionString: urls.owner });
const q: Query = async (text, values) => (await owner.query(text, values)).rows;

let seed: { a: SeededCompany; b: SeededCompany };

beforeAll(async () => {
  await owner.query('select 1');
});

afterAll(async () => {
  await pools.end();
  await owner.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('companiesWithCandidateStorms', () => {
  test('returns only the company whose service area meets a storm of those days', async () => {
    await setFixtureServiceArea(q, seed.a.companyId, OMAHA_BOX);
    await setFixtureServiceArea(q, seed.b.companyId, LINCOLN_BOX);
    await insertOmahaStorm(q, '2026-10-11');
    expect(await companiesWithCandidateStorms(pools.system, { days: ['2026-10-11'] })).toEqual([{ companyId: seed.a.companyId }]);
  });

  test('ignores storms on other days', async () => {
    await setFixtureServiceArea(q, seed.a.companyId, OMAHA_BOX);
    await setFixtureServiceArea(q, seed.b.companyId, LINCOLN_BOX);
    await insertOmahaStorm(q, '2026-10-11');
    expect(await companiesWithCandidateStorms(pools.system, { days: ['2026-10-01'] })).toEqual([]);
  });

  test('a company with no service area is never returned', async () => {
    await setFixtureServiceArea(q, seed.a.companyId, null);
    await setFixtureServiceArea(q, seed.b.companyId, null);
    await insertOmahaStorm(q, '2026-10-11');
    expect(await companiesWithCandidateStorms(pools.system, { days: ['2026-10-11'] })).toEqual([]);
  });

  test('returns each company once even with several storms', async () => {
    await setFixtureServiceArea(q, seed.a.companyId, OMAHA_BOX);
    await insertOmahaStorm(q, '2026-10-11');
    await insertOmahaStorm(q, '2026-10-12');
    const rows = await companiesWithCandidateStorms(pools.system, { days: ['2026-10-11', '2026-10-12'] });
    expect(rows).toEqual([{ companyId: seed.a.companyId }]);
  });

  test('empty days returns nothing', async () => {
    await setFixtureServiceArea(q, seed.a.companyId, OMAHA_BOX);
    await insertOmahaStorm(q, '2026-10-11');
    expect(await companiesWithCandidateStorms(pools.system, { days: [] })).toEqual([]);
  });

  test('two companies in the same city are both returned', async () => {
    await setFixtureServiceArea(q, seed.a.companyId, OMAHA_BOX);
    await setFixtureServiceArea(q, seed.b.companyId, OMAHA_BOX);
    await insertOmahaStorm(q, '2026-10-11');
    const rows = await companiesWithCandidateStorms(pools.system, { days: ['2026-10-11'] });
    expect(rows.map((r) => r.companyId).sort()).toEqual([seed.a.companyId, seed.b.companyId].sort());
  });
});
