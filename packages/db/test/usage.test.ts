import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { recordUsage, type NewUsage } from '../src/repos/usage.ts';
import { usageEvents } from '../src/schema/index.ts';
import { type TenantContext, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });

let seed: { a: SeededCompany; b: SeededCompany };

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

function ctxFor(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: c.owner.userId, role: 'owner', canApproveSpend: true };
}

const base: NewUsage = {
  kind: 'sms_segment',
  quantity: 3,
  unitCostCents: null,
  refType: 'message',
  refId: 'msg-1',
  description: null,
  at: new Date('2026-10-11T12:00:00Z'),
};

/** Records one usage event for a company, in its own tenant transaction. */
function record(c: SeededCompany, input: NewUsage): Promise<boolean> {
  return withTenant(pools, ctxFor(c), (tx) => recordUsage(tx, ctxFor(c), input));
}

/** Every usage row the company can see. */
function rowsFor(c: SeededCompany) {
  return withTenant(pools, ctxFor(c), (tx) => tx.select().from(usageEvents));
}

describe('recordUsage', () => {
  test('writes once per (kind, refType, refId)', async () => {
    const results = [await record(seed.a, base), await record(seed.a, base)];
    expect(results).toEqual([true, false]);

    const rows = await rowsFor(seed.a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'sms_segment', quantity: 3, refType: 'message', refId: 'msg-1' });
  });

  test('a different kind with the same reference is a separate event', async () => {
    expect(await record(seed.a, base)).toBe(true);
    expect(await record(seed.a, { ...base, kind: 'mms' })).toBe(true);

    expect(await rowsFor(seed.a)).toHaveLength(2);
  });

  test('the same reference in another company is a separate event', async () => {
    expect(await record(seed.a, base)).toBe(true);
    expect(await record(seed.b, base)).toBe(true);

    expect(await rowsFor(seed.a)).toHaveLength(1);
    expect(await rowsFor(seed.b)).toHaveLength(1);
  });

  test('stores the description and unit cost', async () => {
    const input: NewUsage = {
      ...base,
      kind: 'exact_report',
      quantity: 1,
      unitCostCents: 1234,
      refType: 'report',
      refId: 'rpt-1',
      description: 'Exact roof report - 812 Oak St',
    };
    expect(await record(seed.a, input)).toBe(true);

    const rows = await rowsFor(seed.a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: 'Exact roof report - 812 Oak St', unitCostCents: 1234 });
  });
});
