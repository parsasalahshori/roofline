import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { adSpendSync } from '../src/jobs/scheduler/ad-spend-sync.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
const NOW = new Date('2026-10-12T15:00:00Z');

let t: TestApp;
let a: string;
let b: string;

async function insertAccount(companyId: string, status: string, platform = 'google', externalId = '1234567890'): Promise<void> {
  await owner.query(`insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, $2, $3, $4)`, [
    companyId,
    platform,
    externalId,
    status,
  ]);
}

afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  a = t.seed.a.companyId;
  b = t.seed.b.companyId;
  await owner.query(`delete from ad_accounts where company_id in ($1, $2)`, [a, b]);
});

describe('ad spend sync schedule', () => {
  test('queues ad-sync-company with singletonKey = companyId for a company with a pending account', async () => {
    await insertAccount(a, 'pending');
    await adSpendSync(t.deps, NOW);
    expect(t.jobs.sent).toEqual([{ name: 'ad-sync-company', data: { companyId: a }, singletonKey: a }]);
  });

  test('queues nothing when no account is pending', async () => {
    await adSpendSync(t.deps, NOW);
    expect(t.jobs.sent).toEqual([]);
  });

  test('an active row and a revoked row do not queue', async () => {
    await insertAccount(a, 'active');
    await insertAccount(b, 'revoked');
    await adSpendSync(t.deps, NOW);
    expect(t.jobs.sent).toEqual([]);
  });

  test('two companies with pending accounts queue two jobs, ordered by company id', async () => {
    await insertAccount(a, 'pending');
    await insertAccount(b, 'pending');
    await adSpendSync(t.deps, NOW);
    const ids = [a, b].sort();
    expect(t.jobs.sent).toEqual(ids.map((id) => ({ name: 'ad-sync-company', data: { companyId: id }, singletonKey: id })));
  });

  test('a failing send for one company is logged and the other company is still queued', async () => {
    await insertAccount(a, 'pending');
    await insertAccount(b, 'pending');
    const [first, second] = [a, b].sort() as [string, string];
    const original = t.deps.jobs.send.bind(t.deps.jobs);
    let failed = false;
    t.deps.jobs.send = (async (...args: Parameters<typeof original>) => {
      if (!failed) {
        failed = true;
        throw new Error('queue down');
      }
      return original(...args);
    }) as typeof original;
    try {
      await adSpendSync(t.deps, NOW);
    } finally {
      t.deps.jobs.send = original;
    }
    expect(t.logged.map((l) => l.where)).toEqual([`ad-spend-sync: company ${first}`]);
    expect(t.jobs.sent).toEqual([{ name: 'ad-sync-company', data: { companyId: second }, singletonKey: second }]);
  });
});
