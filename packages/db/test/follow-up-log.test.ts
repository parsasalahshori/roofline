import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import type { FollowUpKind } from '@roofline/shared';
import { createPools } from '../src/pools.ts';
import { followUpLogFor, lastInboundAt, lastStormTextAt, recordFollowUp } from '../src/repos/follow-up-log.ts';
import { customers, jobs, messages, properties } from '../src/schema/index.ts';
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

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

/** A customer with two jobs, in the given company. */
async function makeCustomer(c: SeededCompany) {
  const ctx = ctxFor(c);
  return withTenant(pools, ctx, async (tx) => {
    const [cust] = await tx.insert(customers).values({ companyId: c.companyId, displayName: 'Pat Customer', createdByUserId: c.owner.userId }).returning({ id: customers.id });
    const [prop] = await tx
      .insert(properties)
      .values({ companyId: c.companyId, customerId: cust!.id, addressLine: '1 Main St', city: 'Omaha', state: 'NE', zip: '68102', addressKey: 'main1' })
      .returning({ id: properties.id });
    const jobIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [job] = await tx
        .insert(jobs)
        .values({ companyId: c.companyId, customerId: cust!.id, propertyId: prop!.id, createdByUserId: c.owner.userId })
        .returning({ id: jobs.id });
      jobIds.push(job!.id);
    }
    return { customerId: cust!.id, jobIds };
  });
}

/** A message row; returns its id. */
async function makeMessage(
  c: SeededCompany,
  customerId: string,
  m: { direction: 'in' | 'out'; at: Date; dedupeKey?: string },
): Promise<string> {
  const ctx = ctxFor(c);
  return withTenant(pools, ctx, async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        companyId: c.companyId,
        customerId,
        channel: 'sms',
        direction: m.direction,
        body: 'Hello',
        status: m.direction === 'in' ? 'received' : 'sent',
        dedupeKey: m.dedupeKey ?? null,
        createdAt: m.at,
        updatedAt: m.at,
      })
      .returning({ id: messages.id });
    return row!.id;
  });
}

async function record(c: SeededCompany, customerId: string, jobId: string | null, kind: FollowUpKind, at: Date, messageId?: string) {
  const ctx = ctxFor(c);
  const id = messageId ?? (await makeMessage(c, customerId, { direction: 'out', at }));
  await withTenant(pools, ctx, (tx) => recordFollowUp(tx, ctx, { customerId, jobId, kind, messageId: id, at }));
  return id;
}

describe('recordFollowUp', () => {
  test('n counts per job and kind, and restarts for another kind', async () => {
    const { customerId, jobIds } = await makeCustomer(seed.a);
    await record(seed.a, customerId, jobIds[0]!, 'proposal', day(1));
    await record(seed.a, customerId, jobIds[0]!, 'proposal', day(2));
    await record(seed.a, customerId, jobIds[0]!, 'review', day(3));
    await record(seed.a, customerId, jobIds[1]!, 'proposal', day(4));
    const ctx = ctxFor(seed.a);
    const rows = await withTenant(pools, ctx, (tx) => followUpLogFor(tx, ctx, [customerId], day(1)));
    expect(rows.map((r) => [r.jobId, r.kind, r.n])).toEqual([
      [jobIds[0], 'proposal', 1],
      [jobIds[0], 'proposal', 2],
      [jobIds[0], 'review', 1],
      [jobIds[1], 'proposal', 1],
    ]);
  });

  test('with no job, n counts per customer and kind', async () => {
    const one = await makeCustomer(seed.a);
    const two = await makeCustomer(seed.a);
    await record(seed.a, one.customerId, null, 'lead', day(1));
    await record(seed.a, one.customerId, null, 'lead', day(2));
    await record(seed.a, two.customerId, null, 'lead', day(3));
    await record(seed.a, one.customerId, one.jobIds[0]!, 'lead', day(4));
    const ctx = ctxFor(seed.a);
    const rows = await withTenant(pools, ctx, (tx) => followUpLogFor(tx, ctx, [one.customerId, two.customerId], day(1)));
    expect(rows.map((r) => [r.customerId, r.jobId, r.n])).toEqual([
      [one.customerId, null, 1],
      [one.customerId, null, 2],
      [two.customerId, null, 1],
      [one.customerId, one.jobIds[0], 1],
    ]);
  });

  test('the same message id twice adds one row', async () => {
    const { customerId, jobIds } = await makeCustomer(seed.a);
    const id = await record(seed.a, customerId, jobIds[0]!, 'proposal', day(1));
    await record(seed.a, customerId, jobIds[0]!, 'proposal', day(2), id);
    const ctx = ctxFor(seed.a);
    const rows = await withTenant(pools, ctx, (tx) => followUpLogFor(tx, ctx, [customerId], day(1)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customerId, jobId: jobIds[0], kind: 'proposal', n: 1, messageId: id, at: day(1) });
  });
});

describe('followUpLogFor', () => {
  test('respects since, customerIds and company', async () => {
    const one = await makeCustomer(seed.a);
    const two = await makeCustomer(seed.a);
    const other = await makeCustomer(seed.b);
    await record(seed.a, one.customerId, null, 'lead', day(1));
    await record(seed.a, one.customerId, null, 'lead', day(5));
    await record(seed.a, two.customerId, null, 'lead', day(6));
    await record(seed.b, other.customerId, null, 'lead', day(6));
    const ctx = ctxFor(seed.a);
    const since = await withTenant(pools, ctx, (tx) => followUpLogFor(tx, ctx, [one.customerId], day(5)));
    expect(since.map((r) => [r.customerId, r.n, r.at])).toEqual([[one.customerId, 2, day(5)]]);
    const both = await withTenant(pools, ctx, (tx) => followUpLogFor(tx, ctx, [one.customerId, two.customerId], day(1)));
    expect(both).toHaveLength(3);
    // Another company's customer is invisible even when named.
    const foreign = await withTenant(pools, ctx, (tx) => followUpLogFor(tx, ctx, [other.customerId], day(1)));
    expect(foreign).toEqual([]);
    // Empty list returns [] without touching the database.
    expect(await withTenant(pools, ctx, (tx) => followUpLogFor(tx, ctx, [], day(1)))).toEqual([]);
  });
});

describe('lastInboundAt', () => {
  test('returns the latest inbound only, null when none', async () => {
    const { customerId } = await makeCustomer(seed.a);
    const ctx = ctxFor(seed.a);
    expect(await withTenant(pools, ctx, (tx) => lastInboundAt(tx, ctx, customerId))).toBeNull();
    await makeMessage(seed.a, customerId, { direction: 'out', at: day(9) });
    expect(await withTenant(pools, ctx, (tx) => lastInboundAt(tx, ctx, customerId))).toBeNull();
    await makeMessage(seed.a, customerId, { direction: 'in', at: day(3) });
    await makeMessage(seed.a, customerId, { direction: 'in', at: day(7) });
    expect(await withTenant(pools, ctx, (tx) => lastInboundAt(tx, ctx, customerId))).toEqual(day(7));
  });
});

describe('lastStormTextAt', () => {
  test('returns the latest storm outbound only, null when none', async () => {
    const { customerId } = await makeCustomer(seed.a);
    const ctx = ctxFor(seed.a);
    expect(await withTenant(pools, ctx, (tx) => lastStormTextAt(tx, ctx, customerId))).toBeNull();
    await makeMessage(seed.a, customerId, { direction: 'out', at: day(9), dedupeKey: 'review:abc' });
    await makeMessage(seed.a, customerId, { direction: 'out', at: day(8) });
    await makeMessage(seed.a, customerId, { direction: 'in', at: day(10), dedupeKey: 'storm:x' });
    expect(await withTenant(pools, ctx, (tx) => lastStormTextAt(tx, ctx, customerId))).toBeNull();
    await makeMessage(seed.a, customerId, { direction: 'out', at: day(2), dedupeKey: 'storm:s1' });
    await makeMessage(seed.a, customerId, { direction: 'out', at: day(5), dedupeKey: 'storm:s2' });
    expect(await withTenant(pools, ctx, (tx) => lastStormTextAt(tx, ctx, customerId))).toEqual(day(5));
  });
});
