import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { insertCall } from '../src/repos/calls.ts';
import { createPools } from '../src/pools.ts';
import { relayCallById } from '../src/system/relay-tokens.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { type TenantContext, withTenant } from '../src/tenant.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });
const { system } = pools;

let seed: { a: SeededCompany; b: SeededCompany };
const ctx = (c: SeededCompany): TenantContext => ({ companyId: c.companyId, userId: null, role: 'system', canApproveSpend: false });

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('relayCallById', () => {
  test('finds a call by id with its company and sid', async () => {
    const row = await withTenant(pools, ctx(seed.a), (tx) =>
      insertCall(tx, ctx(seed.a), {
        callSid: 'CA00000000000000000000000000000001',
        fromE164: '+14025550111',
        toE164: '+14025550100',
        forwardedFrom: null,
        stirVerstat: null,
        now: new Date('2026-10-12T15:00:00Z'),
      }),
    );
    const found = await relayCallById(system, row.id);
    expect(found).toEqual({ callId: row.id, companyId: seed.a.companyId, callSid: 'CA00000000000000000000000000000001', status: row.status });
  });

  test('unknown id returns null', async () => {
    expect(await relayCallById(system, '00000000-0000-4000-8000-000000000999')).toBeNull();
  });

  test('non-uuid returns null', async () => {
    expect(await relayCallById(system, 'not-a-uuid')).toBeNull();
  });
});
