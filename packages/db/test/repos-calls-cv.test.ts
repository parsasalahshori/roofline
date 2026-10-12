import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import {
  applyCallStatus,
  countLiveCallsInWindow,
  findCallBySid,
  findCallConversationId,
  insertCall,
  linkCallConversation,
} from '../src/repos/calls.ts';
import { insertConversation } from '../src/repos/conversations.ts';
import { companyReadOnly } from '../src/repos/front-desk-settings.ts';
import { frontDeskTextsOn } from '../src/repos/fd-texts.ts';
import { createPools } from '../src/pools.ts';
import { calls, companies, companySettings } from '../src/schema/index.ts';
import { endStuckCalls } from '../src/system/stuck-calls.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { type TenantContext, withTenant } from '../src/tenant.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });
const { system } = pools;

let seed: { a: SeededCompany; b: SeededCompany };
const ctx = (c: SeededCompany): TenantContext => ({ companyId: c.companyId, userId: null, role: 'system', canApproveSpend: false });
const NOW = new Date('2026-10-12T15:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

const newCall = (sid: string, startedAt = NOW) => ({
  callSid: sid,
  fromE164: '+14025550111',
  toE164: '+14025550100',
  forwardedFrom: null,
  stirVerstat: null,
  now: startedAt,
});

async function makeCall(c: SeededCompany, sid: string, startedAt: Date, status: 'ringing' | 'ai' | 'ringing_team' | 'ended') {
  const row = await withTenant(pools, ctx(c), (tx) => insertCall(tx, ctx(c), newCall(sid, startedAt)));
  if (status !== 'ringing') {
    await withTenant(pools, ctx(c), (tx) => tx.update(calls).set({ status }).where(eq(calls.id, row.id)));
  }
  return row;
}

describe('linkCallConversation / findCallConversationId', () => {
  test('links once, keeps the first, and is company-scoped', async () => {
    const a = ctx(seed.a);
    const call = await makeCall(seed.a, 'CA1', NOW, 'ringing');
    const { c1, c2 } = await withTenant(pools, a, async (tx) => ({
      c1: (await insertConversation(tx, a, { channel: 'voice', phoneE164: '+14025550111', companyNumberE164: '+14025550100' })).id,
      c2: (await insertConversation(tx, a, { channel: 'voice', phoneE164: '+14025550111', companyNumberE164: '+14025550100' })).id,
    }));
    expect(await withTenant(pools, a, (tx) => findCallConversationId(tx, a, call.id))).toBeNull();
    expect(await withTenant(pools, a, (tx) => linkCallConversation(tx, a, call.id, c1))).toBe(true);
    expect(await withTenant(pools, a, (tx) => linkCallConversation(tx, a, call.id, c2))).toBe(false);
    expect(await withTenant(pools, a, (tx) => findCallConversationId(tx, a, call.id))).toBe(c1);
    const b = ctx(seed.b);
    expect(await withTenant(pools, b, (tx) => linkCallConversation(tx, b, call.id, c2))).toBe(false);
    expect(await withTenant(pools, b, (tx) => findCallConversationId(tx, b, call.id))).toBeNull();
  });
});

describe('countLiveCallsInWindow', () => {
  test('counts ringing and ai within 35 minutes only', async () => {
    const a = ctx(seed.a);
    await makeCall(seed.a, 'CA1', minutesAgo(1), 'ringing');
    await makeCall(seed.a, 'CA2', minutesAgo(10), 'ai');
    await makeCall(seed.a, 'CA3', minutesAgo(10), 'ringing_team');
    await makeCall(seed.a, 'CA4', minutesAgo(10), 'ended');
    await makeCall(seed.a, 'CA5', minutesAgo(36), 'ringing');
    await makeCall(seed.b, 'CB1', minutesAgo(1), 'ringing');
    expect(await withTenant(pools, a, (tx) => countLiveCallsInWindow(tx, a, NOW))).toBe(2);
  });

  test('excludes the call being decided on when its id is passed', async () => {
    const a = ctx(seed.a);
    const ringing = await makeCall(seed.a, 'CA1', NOW, 'ringing');
    await makeCall(seed.a, 'CA2', minutesAgo(5), 'ai');
    expect(await withTenant(pools, a, (tx) => countLiveCallsInWindow(tx, a, NOW))).toBe(2);
    expect(await withTenant(pools, a, (tx) => countLiveCallsInWindow(tx, a, NOW, ringing.id))).toBe(1);
  });
});

describe('applyCallStatus guard', () => {
  test('an ended call stays ended; a ringing call completes with endedAt = now', async () => {
    const a = ctx(seed.a);
    await makeCall(seed.a, 'CA1', minutesAgo(5), 'ringing');
    await makeCall(seed.a, 'CA2', minutesAgo(5), 'ringing');
    const first = new Date(NOW.getTime() - 1000);
    expect(await withTenant(pools, a, (tx) => applyCallStatus(tx, a, 'CA1', 'completed', first))).toBe(true);
    expect(await withTenant(pools, a, (tx) => applyCallStatus(tx, a, 'CA1', 'failed', NOW))).toBe(true);
    const [row] = await withTenant(pools, a, (tx) => tx.select().from(calls).where(eq(calls.callSid, 'CA1')));
    expect(row?.status).toBe('ended');
    expect(row?.endedAt?.getTime()).toBe(first.getTime());
    await withTenant(pools, a, (tx) => applyCallStatus(tx, a, 'CA2', 'completed', NOW));
    const [row2] = await withTenant(pools, a, (tx) => tx.select().from(calls).where(eq(calls.callSid, 'CA2')));
    expect(row2?.status).toBe('ended');
    expect(row2?.endedAt?.getTime()).toBe(NOW.getTime());
    expect(await withTenant(pools, a, (tx) => applyCallStatus(tx, a, 'CAX', 'completed', NOW))).toBe(false);
    expect((await withTenant(pools, a, (tx) => findCallBySid(tx, a, 'CA2')))?.status).toBe('ended');
  });
});

describe('companyReadOnly / frontDeskTextsOn', () => {
  test('read-only only for trial_ended and canceled', async () => {
    const a = ctx(seed.a);
    await system.update(companies).set({ status: 'active' }).where(eq(companies.id, seed.a.companyId));
    expect(await withTenant(pools, a, (tx) => companyReadOnly(tx, a))).toBe(false);
    await system.update(companies).set({ status: 'trial_ended' }).where(eq(companies.id, seed.a.companyId));
    expect(await withTenant(pools, a, (tx) => companyReadOnly(tx, a))).toBe(true);
    await system.update(companies).set({ status: 'canceled' }).where(eq(companies.id, seed.a.companyId));
    expect(await withTenant(pools, a, (tx) => companyReadOnly(tx, a))).toBe(true);
  });

  test('frontDeskTextsOn is false for a canceled company with front desk and texts on', async () => {
    const a = ctx(seed.a);
    await system.update(companies).set({ status: 'active' }).where(eq(companies.id, seed.a.companyId));
    await withTenant(pools, a, (tx) =>
      tx
        .insert(companySettings)
        .values({ companyId: seed.a.companyId, frontDeskEnabled: true, frontDeskTexts: true })
        .onConflictDoUpdate({ target: companySettings.companyId, set: { frontDeskEnabled: true, frontDeskTexts: true } }),
    );
    expect(await withTenant(pools, a, (tx) => frontDeskTextsOn(tx, a))).toBe(true);
    await system.update(companies).set({ status: 'canceled' }).where(eq(companies.id, seed.a.companyId));
    expect(await withTenant(pools, a, (tx) => frontDeskTextsOn(tx, a))).toBe(false);
  });
});

describe('endStuckCalls', () => {
  test('ends only old live calls and returns them', async () => {
    await makeCall(seed.a, 'CA1', minutesAgo(40), 'ringing_team');
    await makeCall(seed.a, 'CA2', minutesAgo(10), 'ai');
    const old = await makeCall(seed.b, 'CB1', minutesAgo(50), 'ended');
    const ended = await endStuckCalls(system, NOW, 10);
    expect(ended).toEqual([{ companyId: seed.a.companyId, callSid: 'CA1' }]);
    const a = ctx(seed.a);
    expect((await withTenant(pools, a, (tx) => findCallBySid(tx, a, 'CA1')))?.status).toBe('ended');
    expect((await withTenant(pools, a, (tx) => findCallBySid(tx, a, 'CA2')))?.status).toBe('ai');
    const b = ctx(seed.b);
    const [bRow] = await withTenant(pools, b, (tx) => tx.select().from(calls).where(eq(calls.id, old.id)));
    expect(bRow?.endedAt).toBeNull();
    expect(await endStuckCalls(system, NOW, 10)).toEqual([]);
  });
});
