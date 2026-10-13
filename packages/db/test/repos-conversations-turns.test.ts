import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { insertConversation, listIdleSmsConversationIds, loadCompanyFacts, updateConversation } from '../src/repos/conversations.ts';
import { insertTurn, listTurns, recordModelFailureHandoff, updateTurn } from '../src/repos/turns.ts';
import { conversations, conversationTurns } from '../src/schema/index.ts';
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

function newConversation(c: SeededCompany): Promise<string> {
  return withTenant(pools, ctxFor(c), async (tx) => {
    const { id } = await insertConversation(tx, ctxFor(c), {
      channel: 'sms',
      phoneE164: '+14025550111',
      companyNumberE164: c.phoneE164,
    });
    return id;
  });
}

describe('conversations repo', () => {
  test('insertConversation then loadCompanyFacts returns the company name, timezone and facts', async () => {
    const id = await newConversation(seed.a);
    const rows = await withTenant(pools, ctxFor(seed.a), (tx) => tx.select().from(conversations));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, companyId: seed.a.companyId, identity: 'unknown', status: 'active', customerId: null });

    const facts = await withTenant(pools, ctxFor(seed.a), (tx) => loadCompanyFacts(tx, ctxFor(seed.a)));
    expect(facts.name).toBe(seed.a.name);
    expect(typeof facts.timezone).toBe('string');
    expect(facts.timezone.length).toBeGreaterThan(0);
    expect(typeof facts.facts).toBe('string');
    expect(Array.isArray(facts.workHours['mon'])).toBe(true);
    expect(facts.canMove).toBe(true);
    expect(facts.canCancel).toBe(true);

    const other = await withTenant(pools, ctxFor(seed.b), (tx) => loadCompanyFacts(tx, ctxFor(seed.b)));
    expect(other.name).toBe(seed.b.name);
  });

  test('updateConversation sets outcome and status', async () => {
    const id = await newConversation(seed.a);
    const at = new Date('2026-10-12T15:00:00Z');
    await withTenant(pools, ctxFor(seed.a), (tx) =>
      updateConversation(tx, ctxFor(seed.a), id, { outcome: 'booked', status: 'ended', summary: 'Booked an inspection', lastMessageAt: at }),
    );
    const [row] = await withTenant(pools, ctxFor(seed.a), (tx) => tx.select().from(conversations));
    expect(row).toMatchObject({ outcome: 'booked', status: 'ended', summary: 'Booked an inspection', identity: 'unknown' });
    expect(row!.lastMessageAt.toISOString()).toBe(at.toISOString());
  });

  test('updateConversation unreadAtLeast raises the count and never lowers it', async () => {
    const id = await newConversation(seed.a);
    const ctx = ctxFor(seed.a);
    const unread = async () => (await withTenant(pools, ctx, (tx) => tx.select().from(conversations)))[0]!.unreadCount;
    await withTenant(pools, ctx, (tx) => updateConversation(tx, ctx, id, { unreadAtLeast: 1 }));
    expect(await unread()).toBe(1);
    await withTenant(pools, ctx, (tx) => tx.update(conversations).set({ unreadCount: 3 }));
    await withTenant(pools, ctx, (tx) => updateConversation(tx, ctx, id, { unreadAtLeast: 1 }));
    expect(await unread()).toBe(3);
  });

  test('listIdleSmsConversationIds filters channel, status and age, respects the limit, and stays in the company', async () => {
    const ctx = ctxFor(seed.a);
    const now = new Date('2026-10-12T15:00:00Z');
    const mk = (channel: 'sms' | 'voice', status: 'active' | 'ended', hoursAgo: number, phone: string) =>
      withTenant(pools, ctx, async (tx) => {
        const [r] = await tx
          .insert(conversations)
          .values({
            companyId: ctx.companyId,
            channel,
            status,
            phoneE164: phone,
            companyNumberE164: seed.a.phoneE164,
            lastMessageAt: new Date(now.getTime() - hoursAgo * 3600_000),
          })
          .returning({ id: conversations.id });
        return r!.id;
      });
    const oldest = await mk('sms', 'active', 50, '+14025550301');
    const older = await mk('sms', 'active', 30, '+14025550302');
    await mk('sms', 'active', 1, '+14025550303');
    await mk('voice', 'active', 30, '+14025550304');
    await mk('sms', 'ended', 30, '+14025550305');
    const cb = ctxFor(seed.b);
    await withTenant(pools, cb, (tx) =>
      tx.insert(conversations).values({ companyId: cb.companyId, channel: 'sms', phoneE164: '+14025550306', companyNumberE164: seed.b.phoneE164, lastMessageAt: new Date(now.getTime() - 40 * 3600_000) }),
    );
    const before = new Date(now.getTime() - 24 * 3600_000);
    expect(await withTenant(pools, ctx, (tx) => listIdleSmsConversationIds(tx, ctx, before, 10))).toEqual([oldest, older]);
    expect(await withTenant(pools, ctx, (tx) => listIdleSmsConversationIds(tx, ctx, before, 1))).toEqual([oldest]);
  });

  test('listIdleSmsConversationIds with endedSince also lists unsummarised gap-ended threads in the lookback, never spam (RC-2 #5)', async () => {
    const ctx = ctxFor(seed.a);
    const now = new Date('2026-10-12T15:00:00Z');
    const mk = (status: 'active' | 'ended', hoursAgo: number, phone: string, extra: { summary?: string; outcome?: 'spam' | 'other' } = {}) =>
      withTenant(pools, ctx, async (tx) => {
        const [r] = await tx
          .insert(conversations)
          .values({
            companyId: ctx.companyId,
            channel: 'sms',
            status,
            phoneE164: phone,
            companyNumberE164: seed.a.phoneE164,
            lastMessageAt: new Date(now.getTime() - hoursAgo * 3600_000),
            ...extra,
          })
          .returning({ id: conversations.id });
        return r!.id;
      });
    const gapEnded = await mk('ended', 40, '+14025550311');
    const idle = await mk('active', 30, '+14025550312');
    await mk('ended', 30, '+14025550313', { outcome: 'spam' });
    await mk('ended', 30, '+14025550314', { summary: 'Done.' });
    await mk('ended', 8 * 24, '+14025550315');
    await mk('ended', 2, '+14025550316');
    const gapEndedOtherOutcome = await mk('ended', 26, '+14025550317', { outcome: 'other' });
    const before = new Date(now.getTime() - 24 * 3600_000);
    const endedSince = new Date(now.getTime() - 7 * 24 * 3600_000);
    expect(await withTenant(pools, ctx, (tx) => listIdleSmsConversationIds(tx, ctx, before, 10, endedSince))).toEqual([
      gapEnded,
      idle,
      gapEndedOtherOutcome,
    ]);
    expect(await withTenant(pools, ctx, (tx) => listIdleSmsConversationIds(tx, ctx, before, 10))).toEqual([idle]);
  });
});

describe('turns repo', () => {
  test('insertTurn stores timings tokens and guard hits', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    const { id } = await withTenant(pools, c, (tx) =>
      insertTurn(tx, c, {
        conversationId: convo,
        speaker: 'assistant',
        text: 'Hello there.',
        model: 'claude-test',
        route: 'fast',
        routerMs: 12,
        firstTokenMs: 300,
        totalMs: 900,
        inputTokens: 1000,
        cachedTokens: 800,
        outputTokens: 40,
        toolCalls: [{ name: 'lookup', input: { a: 1 }, result: 'ok', ok: true }],
        guardHits: ['price'],
      }),
    );
    const [row] = await withTenant(pools, c, (tx) => tx.select().from(conversationTurns));
    expect(row).toMatchObject({
      id,
      companyId: seed.a.companyId,
      conversationId: convo,
      position: 0,
      speaker: 'assistant',
      text: 'Hello there.',
      truncated: false,
      model: 'claude-test',
      route: 'fast',
      routerMs: 12,
      firstTokenMs: 300,
      totalMs: 900,
      inputTokens: 1000,
      cachedTokens: 800,
      outputTokens: 40,
      guardHits: ['price'],
    });
    expect(row!.toolCalls).toEqual([{ name: 'lookup', input: { a: 1 }, result: 'ok', ok: true }]);

    const { id: id2 } = await withTenant(pools, c, (tx) =>
      insertTurn(tx, c, { conversationId: convo, speaker: 'caller', text: 'Hi' }),
    );
    const rows = await withTenant(pools, c, (tx) => listTurns(tx, c, convo));
    expect(rows.find((r) => r.id === id2)?.guardHits).toEqual([]);
  });

  test('insertTurn allocates consecutive positions starting at 0', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    for (const speaker of ['caller', 'assistant', 'caller'] as const) {
      await withTenant(pools, c, (tx) => insertTurn(tx, c, { conversationId: convo, speaker, text: 'x' }));
    }
    const rows = await withTenant(pools, c, (tx) => listTurns(tx, c, convo));
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  test('a passed position is ignored', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    await withTenant(pools, c, (tx) => insertTurn(tx, c, { conversationId: convo, position: 7, speaker: 'caller', text: 'a' }));
    const rows = await withTenant(pools, c, (tx) => listTurns(tx, c, convo));
    expect(rows.map((r) => r.position)).toEqual([0]);
  });

  test('two concurrent insertTurn calls in separate transactions get distinct positions', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    await Promise.all([
      withTenant(pools, c, (tx) => insertTurn(tx, c, { conversationId: convo, speaker: 'caller', text: 'a' })),
      withTenant(pools, c, (tx) => insertTurn(tx, c, { conversationId: convo, speaker: 'assistant', text: 'b' })),
    ]);
    const rows = await withTenant(pools, c, (tx) => listTurns(tx, c, convo));
    expect(rows.map((r) => r.position).sort()).toEqual([0, 1]);
  });

  test('updateTurn changes only text, tool_calls and truncated', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    const { id } = await withTenant(pools, c, (tx) =>
      insertTurn(tx, c, { conversationId: convo, speaker: 'assistant', text: 'Long answer', model: 'm', totalMs: 500, guardHits: ['x'] }),
    );
    await withTenant(pools, c, (tx) =>
      updateTurn(tx, c, id, { text: 'Long', truncated: true, toolCalls: [{ name: 't', input: {}, result: 'r', ok: false }] }),
    );
    await withTenant(pools, c, (tx) => updateTurn(tx, c, id, {}));
    const [row] = await withTenant(pools, c, (tx) => tx.select().from(conversationTurns));
    expect(row).toMatchObject({ text: 'Long', truncated: true, model: 'm', totalMs: 500, guardHits: ['x'], position: 0, speaker: 'assistant' });
    expect(row!.toolCalls).toEqual([{ name: 't', input: {}, result: 'r', ok: false }]);
  });

  test('listTurns returns turns in position order', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    for (const n of [1, 2, 3]) {
      await withTenant(pools, c, (tx) =>
        insertTurn(tx, c, { conversationId: convo, speaker: n % 2 ? 'caller' : 'assistant', text: `t${n}` }),
      );
    }
    const rows = await withTenant(pools, c, (tx) => listTurns(tx, c, convo));
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.text)).toEqual(['t1', 't2', 't3']);
  });

  test('company B cannot see or update company A turns', async () => {
    const convo = await newConversation(seed.a);
    const a = ctxFor(seed.a);
    const b = ctxFor(seed.b);
    const { id } = await withTenant(pools, a, (tx) =>
      insertTurn(tx, a, { conversationId: convo, speaker: 'caller', text: 'secret' }),
    );
    expect(await withTenant(pools, b, (tx) => listTurns(tx, b, convo))).toEqual([]);
    await withTenant(pools, b, (tx) => updateTurn(tx, b, id, { text: 'hacked', truncated: true }));
    const rows = await withTenant(pools, a, (tx) => listTurns(tx, a, convo));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'secret', truncated: false });
    await expect(
      withTenant(pools, b, (tx) => insertTurn(tx, b, { conversationId: convo, speaker: 'caller', text: 'x' })),
    ).rejects.toThrow();
  });
});

describe('recordModelFailureHandoff', () => {
  test('adds one hand-off turn at the next position; a second call is a no-op', async () => {
    const id = await newConversation(seed.a);
    const ctx = ctxFor(seed.a);
    await withTenant(pools, ctx, async (tx) => {
      await insertTurn(tx, ctx, { conversationId: id, position: 0, speaker: 'caller', text: 'hello' });
      await insertTurn(tx, ctx, { conversationId: id, position: 1, speaker: 'assistant', text: 'hi' });
    });
    await withTenant(pools, ctx, (tx) => recordModelFailureHandoff(tx, ctx, id));
    await withTenant(pools, ctx, (tx) => recordModelFailureHandoff(tx, ctx, id));
    const turns = await withTenant(pools, ctx, (tx) => listTurns(tx, ctx, id));
    expect(turns.map((t) => t.position)).toEqual([0, 1, 2]);
    expect(turns[2]).toMatchObject({ speaker: 'system', guardHits: ['model_failure'] });
  });

  test('concurrent calls on one conversation neither collide on a position nor write two hand-offs', async () => {
    const id = await newConversation(seed.a);
    const ctx = ctxFor(seed.a);
    await withTenant(pools, ctx, (tx) => insertTurn(tx, ctx, { conversationId: id, position: 0, speaker: 'caller', text: 'hello' }));
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => withTenant(pools, ctx, (tx) => recordModelFailureHandoff(tx, ctx, id))),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const turns = await withTenant(pools, ctx, (tx) => listTurns(tx, ctx, id));
    expect(turns.map((t) => t.position)).toEqual([0, 1]);
    expect(turns.filter((t) => t.guardHits.includes('model_failure'))).toHaveLength(1);
  });

  test('another company conversation id is a no-op', async () => {
    const id = await newConversation(seed.a);
    const ctxB = ctxFor(seed.b);
    await withTenant(pools, ctxB, (tx) => recordModelFailureHandoff(tx, ctxB, id));
    const turns = await withTenant(pools, ctxFor(seed.a), (tx) => listTurns(tx, ctxFor(seed.a), id));
    expect(turns).toEqual([]);
  });
});
