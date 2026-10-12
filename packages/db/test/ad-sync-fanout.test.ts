import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { companiesWithPendingAdAccounts } from '../src/system/ad-sync-fanout.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });
const owner = new pg.Pool({ connectionString: urls.owner });

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

describe('companiesWithPendingAdAccounts', () => {
  test('lists only companies with a pending ad account, and drops them once active', async () => {
    await owner.query(
      `insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, 'google', '1234567890', 'pending')`,
      [seed.a.companyId],
    );
    await owner.query(
      `insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, 'meta', 'act_99', 'active')`,
      [seed.b.companyId],
    );
    expect(await companiesWithPendingAdAccounts(pools.system)).toEqual([{ companyId: seed.a.companyId }]);
    await owner.query(`update ad_accounts set status = 'active' where company_id = $1`, [seed.a.companyId]);
    expect(await companiesWithPendingAdAccounts(pools.system)).toEqual([]);
  });
});
