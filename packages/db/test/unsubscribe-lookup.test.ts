import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools, type Pools } from '../src/pools.ts';
import { companyForUnsubscribe, recordEmailOptOut } from '../src/system/unsubscribe-lookup.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');

let owner: pg.Client;
let pools: Pools;
let seed: { a: SeededCompany; b: SeededCompany };

beforeAll(async () => {
  owner = new pg.Client({ connectionString: urls.owner });
  await owner.connect();
  pools = createPools({ tenant: urls.tenant, system: urls.system });
});

afterAll(async () => {
  await pools?.end();
  await owner?.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

/** Opt-out rows for one company, read as the owner so row-level security does not hide them. */
async function optOutRows(companyId: string): Promise<{ email: string; source: string }[]> {
  const res = await owner.query<{ email: string; source: string }>(
    'select email, source from email_opt_outs where company_id = $1 order by email',
    [companyId],
  );
  return res.rows;
}

describe('companyForUnsubscribe', () => {
  test('returns the id and name of the company', async () => {
    const found = await companyForUnsubscribe(pools.system, seed.a.companyId);
    expect(found).toEqual({ id: seed.a.companyId, name: seed.a.name });
  });

  test('returns null for a company that does not exist', async () => {
    expect(await companyForUnsubscribe(pools.system, randomUUID())).toBeNull();
  });
});

describe('recordEmailOptOut', () => {
  test('adds one row on the first call and nothing on a repeat', async () => {
    const input = { companyId: seed.a.companyId, email: 'pat@example.com', source: 'link' as const };

    expect(await recordEmailOptOut(pools.system, input)).toBe(true);
    expect(await recordEmailOptOut(pools.system, input)).toBe(false);

    expect(await optOutRows(seed.a.companyId)).toEqual([{ email: 'pat@example.com', source: 'link' }]);
  });

  test('matches the address case-insensitively (citext)', async () => {
    expect(
      await recordEmailOptOut(pools.system, { companyId: seed.a.companyId, email: 'Pat@Example.com', source: 'one_click' }),
    ).toBe(true);
    expect(
      await recordEmailOptOut(pools.system, { companyId: seed.a.companyId, email: 'pat@example.COM', source: 'link' }),
    ).toBe(false);

    expect(await optOutRows(seed.a.companyId)).toEqual([{ email: 'Pat@Example.com', source: 'one_click' }]);
  });

  test('the same address opts out of each company separately', async () => {
    expect(
      await recordEmailOptOut(pools.system, { companyId: seed.a.companyId, email: 'pat@example.com', source: 'link' }),
    ).toBe(true);
    expect(
      await recordEmailOptOut(pools.system, { companyId: seed.b.companyId, email: 'pat@example.com', source: 'link' }),
    ).toBe(true);

    expect(await optOutRows(seed.b.companyId)).toEqual([{ email: 'pat@example.com', source: 'link' }]);
  });
});
