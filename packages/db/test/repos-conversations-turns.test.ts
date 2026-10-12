import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { insertConversation, listIdleSmsConversationIds, loadCompanyFacts, updateConversation } from '../src/repos/conversations.ts';
import { insertTurn, listTurns, updateTurn } from '../src/repos/turns.ts';
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
});

describe('turns repo', () => {
  test('insertTurn stores timings tokens and guard hits', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    const { id } = await withTenant(pools, c, (tx) =>
      insertTurn(tx, c, {
        conversationId: convo,
        position: 1,
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
      position: 1,
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
      insertTurn(tx, c, { conversationId: convo, position: 2, speaker: 'caller', text: 'Hi' }),
    );
    const rows = await withTenant(pools, c, (tx) => listTurns(tx, c, convo));
    expect(rows.find((r) => r.id === id2)?.guardHits).toEqual([]);
  });

  test('insertTurn rejects a duplicate position in one conversation', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    await withTenant(pools, c, (tx) => insertTurn(tx, c, { conversationId: convo, position: 1, speaker: 'caller', text: 'a' }));
    await expect(
      withTenant(pools, c, (tx) => insertTurn(tx, c, { conversationId: convo, position: 1, speaker: 'assistant', text: 'b' })),
    ).rejects.toThrow();
  });

  test('updateTurn changes only text, tool_calls and truncated', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    const { id } = await withTenant(pools, c, (tx) =>
      insertTurn(tx, c, { conversationId: convo, position: 1, speaker: 'assistant', text: 'Long answer', model: 'm', totalMs: 500, guardHits: ['x'] }),
    );
    await withTenant(pools, c, (tx) =>
      updateTurn(tx, c, id, { text: 'Long', truncated: true, toolCalls: [{ name: 't', input: {}, result: 'r', ok: false }] }),
    );
    await withTenant(pools, c, (tx) => updateTurn(tx, c, id, {}));
    const [row] = await withTenant(pools, c, (tx) => tx.select().from(conversationTurns));
    expect(row).toMatchObject({ text: 'Long', truncated: true, model: 'm', totalMs: 500, guardHits: ['x'], position: 1, speaker: 'assistant' });
    expect(row!.toolCalls).toEqual([{ name: 't', input: {}, result: 'r', ok: false }]);
  });

  test('listTurns returns turns in position order', async () => {
    const convo = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    for (const position of [3, 1, 2]) {
      await withTenant(pools, c, (tx) =>
        insertTurn(tx, c, { conversationId: convo, position, speaker: position % 2 ? 'caller' : 'assistant', text: `t${position}` }),
      );
    }
    const rows = await withTenant(pools, c, (tx) => listTurns(tx, c, convo));
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.text)).toEqual(['t1', 't2', 't3']);
  });

  test('company B cannot see or update company A turns', async () => {
    const convo = await newConversation(seed.a);
    const a = ctxFor(seed.a);
    const b = ctxFor(seed.b);
    const { id } = await withTenant(pools, a, (tx) =>
      insertTurn(tx, a, { conversationId: convo, position: 1, speaker: 'caller', text: 'secret' }),
    );
    expect(await withTenant(pools, b, (tx) => listTurns(tx, b, convo))).toEqual([]);
    await withTenant(pools, b, (tx) => updateTurn(tx, b, id, { text: 'hacked', truncated: true }));
    const rows = await withTenant(pools, a, (tx) => listTurns(tx, a, convo));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'secret', truncated: false });
    await expect(
      withTenant(pools, b, (tx) => insertTurn(tx, b, { conversationId: convo, position: 2, speaker: 'caller', text: 'x' })),
    ).rejects.toThrow();
  });
});
