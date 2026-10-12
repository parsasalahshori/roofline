import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { applyCallStatus, findCallBySid, frontDeskCallSettings, insertCall, screeningFacts } from '../src/repos/calls.ts';
import { createPools } from '../src/pools.ts';
import { blockedNumbers, companies, companyPhoneNumbers, companySettings, customers, memberships } from '../src/schema/index.ts';
import { onCallMembers, teamDialNumbers, voiceRouteForNumber } from '../src/system/voice-routing.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { type TenantContext, withTenant } from '../src/tenant.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });
const { system } = pools;

let seed: { a: SeededCompany; b: SeededCompany };
const ctx = (c: SeededCompany): TenantContext => ({ companyId: c.companyId, userId: null, role: 'system', canApproveSpend: false });
const NOW = new Date('2026-10-12T15:00:00Z');

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

const call = (sid: string, from = '+14025550111', now = NOW) => ({
  callSid: sid,
  fromE164: from,
  toE164: '+14025550100',
  forwardedFrom: null,
  stirVerstat: null,
  now,
});

describe('voiceRouteForNumber', () => {
  test('voiceRouteForNumber routes an active number and not an inactive one', async () => {
    await system.insert(companyPhoneNumbers).values([
      { companyId: seed.a.companyId, e164: '+14025550100', capabilities: ['voice'] },
      { companyId: seed.a.companyId, e164: '+14025550101', capabilities: ['voice'], status: 'released' },
    ]);
    const route = await voiceRouteForNumber(system, '+14025550100');
    expect(route?.companyId).toBe(seed.a.companyId);
    expect(route?.companyName).toBe(seed.a.name);
    expect(route?.readOnly).toBe(false);
    expect(await voiceRouteForNumber(system, '+14025550101')).toBeNull();
    expect(await voiceRouteForNumber(system, '+14025550102')).toBeNull();
  });

  test('voiceRouteForNumber says when the company is read-only (Ruling BG)', async () => {
    await system.insert(companyPhoneNumbers).values({ companyId: seed.a.companyId, e164: '+14025550100', capabilities: ['voice'] });
    for (const [status, readOnly] of [['trial_ended', true], ['canceled', true], ['past_due', false], ['active', false]] as const) {
      await system.update(companies).set({ status }).where(eq(companies.id, seed.a.companyId));
      expect((await voiceRouteForNumber(system, '+14025550100'))?.readOnly, status).toBe(readOnly);
    }
  });

  test('voiceRouteForNumber never returns another company', async () => {
    await system.insert(companyPhoneNumbers).values([
      { companyId: seed.a.companyId, e164: '+14025550100', capabilities: ['voice'] },
      { companyId: seed.b.companyId, e164: '+14025550200', capabilities: ['voice'] },
    ]);
    expect((await voiceRouteForNumber(system, '+14025550100'))?.companyId).toBe(seed.a.companyId);
    expect((await voiceRouteForNumber(system, '+14025550200'))?.companyId).toBe(seed.b.companyId);
  });
});

describe('frontDeskCallSettings', () => {
  test('frontDeskCallSettings reads this company settings and defaults for another', async () => {
    await withTenant(pools, ctx(seed.a), (tx) =>
      tx
        .update(companySettings)
        .set({ frontDeskEnabled: true, maxConcurrentAiCalls: 2 })
        .where(eq(companySettings.companyId, seed.a.companyId)),
    );
    const a = await withTenant(pools, ctx(seed.a), (tx) => frontDeskCallSettings(tx, ctx(seed.a)));
    expect(a.frontDeskEnabled).toBe(true);
    expect(a.maxConcurrentAiCalls).toBe(2);
    const b = await withTenant(pools, ctx(seed.b), (tx) => frontDeskCallSettings(tx, ctx(seed.b)));
    expect(b.frontDeskEnabled).toBe(false);
    expect(b.maxConcurrentAiCalls).toBe(4);
  });
});

describe('onCallMembers', () => {
  test('onCallMembers orders by on_call_order and skips members without a phone or order', async () => {
    const set = (userId: string, v: { transferPhoneE164: string | null; onCallOrder: number | null }) =>
      system
        .update(memberships)
        .set(v)
        .where(and(eq(memberships.companyId, seed.a.companyId), eq(memberships.userId, userId)));
    await set(seed.a.owner.userId, { transferPhoneE164: '+14025550301', onCallOrder: 2 });
    await set(seed.a.office.userId, { transferPhoneE164: '+14025550302', onCallOrder: 1 });
    await set(seed.a.rep.userId, { transferPhoneE164: '+14025550303', onCallOrder: null });
    await set(seed.a.otherRep.userId, { transferPhoneE164: null, onCallOrder: 3 });
    await set(seed.b.owner.userId, { transferPhoneE164: '+14025550399', onCallOrder: 1 });

    const members = await onCallMembers(system, seed.a.companyId);
    expect(members).toEqual([
      { userId: seed.a.office.userId, phone: '+14025550302', onCallOrder: 1 },
      { userId: seed.a.owner.userId, phone: '+14025550301', onCallOrder: 2 },
    ]);
    expect(await teamDialNumbers(system, seed.a.companyId)).toEqual(['+14025550302', '+14025550301']);
  });
});

describe('calls', () => {
  test('insertCall is idempotent on the same CallSid', async () => {
    const first = await withTenant(pools, ctx(seed.a), (tx) => insertCall(tx, ctx(seed.a), call('CA1')));
    const second = await withTenant(pools, ctx(seed.a), (tx) => insertCall(tx, ctx(seed.a), call('CA1')));
    expect(second.id).toBe(first.id);
    expect(first.status).toBe('ringing');
    expect(first.companyId).toBe(seed.a.companyId);
  });

  test('screeningFacts reports blocked, recent calls and known customer', async () => {
    await withTenant(pools, ctx(seed.a), async (tx) => {
      await tx.insert(blockedNumbers).values({ companyId: seed.a.companyId, e164: '+14025550666' });
      await tx.insert(customers).values({
        companyId: seed.a.companyId,
        displayName: 'Known Caller',
        phones: [{ e164: '+14025550777', label: 'mobile', primary: true }],
      });
      await insertCall(tx, ctx(seed.a), call('CA10', '+14025550888', new Date(NOW.getTime() - 30 * 60_000)));
      await insertCall(tx, ctx(seed.a), call('CA11', '+14025550888', new Date(NOW.getTime() - 5 * 3_600_000)));
      await insertCall(tx, ctx(seed.a), call('CA12', '+14025550888', NOW));
    });
    const facts = (from: string) => withTenant(pools, ctx(seed.a), (tx) => screeningFacts(tx, ctx(seed.a), from, NOW));
    expect(await facts('+14025550666')).toEqual({ blocked: true, callsLastHour: 0, knownCustomer: false });
    expect(await facts('+14025550777')).toEqual({ blocked: false, callsLastHour: 0, knownCustomer: true });
    expect(await facts('+14025550888')).toEqual({ blocked: false, callsLastHour: 2, knownCustomer: false });
    const other = await withTenant(pools, ctx(seed.b), (tx) => screeningFacts(tx, ctx(seed.b), '+14025550888', NOW));
    expect(other.callsLastHour).toBe(0);
  });

  test('applyCallStatus ends a call and never reopens an ended one', async () => {
    const c = ctx(seed.a);
    await withTenant(pools, c, (tx) => insertCall(tx, c, call('CA20')));
    expect(await withTenant(pools, c, (tx) => applyCallStatus(tx, c, 'CA20', 'in-progress', NOW))).toBe(true);
    expect((await withTenant(pools, c, (tx) => findCallBySid(tx, c, 'CA20')))?.status).toBe('ringing');
    expect(await withTenant(pools, c, (tx) => applyCallStatus(tx, c, 'CA20', 'completed', NOW))).toBe(true);
    expect((await withTenant(pools, c, (tx) => findCallBySid(tx, c, 'CA20')))?.status).toBe('ended');
    await withTenant(pools, c, (tx) => applyCallStatus(tx, c, 'CA20', 'failed', NOW));
    expect((await withTenant(pools, c, (tx) => findCallBySid(tx, c, 'CA20')))?.status).toBe('ended');
    expect(await withTenant(pools, c, (tx) => applyCallStatus(tx, c, 'CA-unknown', 'completed', NOW))).toBe(false);
    // Another company cannot see or end it.
    const b = ctx(seed.b);
    expect(await withTenant(pools, b, (tx) => applyCallStatus(tx, b, 'CA20', 'completed', NOW))).toBe(false);
  });
});
