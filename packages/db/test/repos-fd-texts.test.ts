import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { insertInboundText } from '../src/repos/inbound.ts';
import {
  attachInboundToConversation,
  frontDeskTextsOn,
  insertAssistantText,
  lastTeamReplyAt,
  listConversationTexts,
  listUnansweredInbound,
} from '../src/repos/fd-texts.ts';
import { companySettings, conversations, messages } from '../src/schema/index.ts';
import { type TenantContext, type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });
const PHONE = '+14025550111';

let seed: { a: SeededCompany; b: SeededCompany };
let sidCounter = 0;

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
  sidCounter = 0;
});

function ctxFor(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: c.owner.userId, role: 'owner', canApproveSpend: true };
}

/** Stores an inbound text at `at` and files it under a conversation, in the caller's transaction (as /sms does). */
async function receiveIn(tx: Tx, at: Date, body = 'hello') {
  const ctx = ctxFor(seed.a);
  sidCounter += 1;
  const messageId = await insertInboundText(
    tx,
    ctx,
    { customerId: null, body, fromE164: PHONE, toE164: seed.a.phoneE164, providerSid: `SM${String(sidCounter).padStart(32, '0')}` },
    at,
  );
  const conv = await attachInboundToConversation(
    tx,
    ctx,
    { messageId: messageId!, phoneE164: PHONE, companyNumberE164: seed.a.phoneE164, customerId: null },
    at,
  );
  return { messageId: messageId!, conv };
}

/** Stores an inbound text at `at` and files it under a conversation. */
async function receive(at: Date, body = 'hello') {
  return withTenant(pools, ctxFor(seed.a), (tx) => receiveIn(tx, at, body));
}

/** Waits (up to 5 s) until some connection is waiting for a lock; false when none ever does. */
async function untilLockWait(): Promise<boolean> {
  const observer = new pg.Client({ connectionString: urls.owner });
  await observer.connect();
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { rows } = await observer.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (rows[0]!.n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  } finally {
    await observer.end();
  }
}

/**
 * Two texts from PHONE racing: the first is filed and its transaction held open; the second starts,
 * and once it waits on a lock the first commits. Returns both refs.
 */
async function race(firstAt: Date, secondAt: Date) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let filed!: () => void;
  const firstFiled = new Promise<void>((resolve) => (filed = resolve));
  const first = withTenant(pools, ctxFor(seed.a), async (tx) => {
    const ref = await receiveIn(tx, firstAt, 'first');
    filed();
    await held;
    return ref;
  });
  await firstFiled;
  const second = receive(secondAt, 'second');
  const waited = await untilLockWait();
  release();
  const results = await Promise.allSettled([first, second]);
  expect(waited).toBe(true);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  const [a, b] = results as PromiseFulfilledResult<Awaited<ReturnType<typeof receive>>>[];
  return { first: a!.value, second: b!.value };
}

const T0 = new Date('2026-10-12T15:00:00Z');
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

describe('fd-texts repo', () => {
  test('two texts 1 hour apart share one conversation', async () => {
    const first = await receive(T0);
    const second = await receive(hours(1));
    expect(first.conv.created).toBe(true);
    expect(second.conv.created).toBe(false);
    expect(second.conv.id).toBe(first.conv.id);
    const rows = await withTenant(pools, ctxFor(seed.a), (tx) => tx.select().from(conversations));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unreadCount).toBe(2);
  });

  test('a text 25 hours after the last starts a new conversation and ends the old one', async () => {
    const first = await receive(T0);
    const second = await receive(hours(25));
    expect(second.conv.created).toBe(true);
    expect(second.conv.id).not.toBe(first.conv.id);
    const old = await withTenant(pools, ctxFor(seed.a), (tx) =>
      tx.select().from(conversations).where(eq(conversations.id, first.conv.id)),
    );
    expect(old[0]!.status).toBe('ended');
  });

  test('two first texts racing from a number with no conversation: the second waits and joins the first', async () => {
    const { first, second } = await race(T0, new Date(T0.getTime() + 1000));
    expect(first.conv.created).toBe(true);
    expect(second.conv.created).toBe(false);
    expect(second.conv.id).toBe(first.conv.id);
    const rows = await withTenant(pools, ctxFor(seed.a), (tx) => tx.select().from(conversations));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unreadCount).toBe(2);
    const texts = await withTenant(pools, ctxFor(seed.a), (tx) => tx.select().from(messages));
    expect(texts.map((m) => m.conversationId)).toEqual([first.conv.id, first.conv.id]);
  });

  test('two texts racing after a 24 hour gap: one new conversation, the old one ended', async () => {
    const old = await receive(T0);
    const { first, second } = await race(hours(25), new Date(hours(25).getTime() + 1000));
    expect(first.conv.created).toBe(true);
    expect(second.conv.id).toBe(first.conv.id);
    const rows = await withTenant(pools, ctxFor(seed.a), (tx) => tx.select().from(conversations));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === old.conv.id)!.status).toBe('ended');
    const fresh = rows.find((r) => r.id === first.conv.id)!;
    expect(fresh.status).toBe('active');
    expect(fresh.unreadCount).toBe(2);
  });

  test('attach sets messages.conversation_id', async () => {
    const { messageId, conv } = await receive(T0);
    const [row] = await withTenant(pools, ctxFor(seed.a), (tx) => tx.select().from(messages).where(eq(messages.id, messageId)));
    expect(row!.conversationId).toBe(conv.id);
  });

  test('listUnansweredInbound returns only texts after the last outbound', async () => {
    const ctx = ctxFor(seed.a);
    const one = await receive(T0, 'one');
    const customerId = await customer();
    await withTenant(pools, ctx, (tx) =>
      insertAssistantText(tx, ctx, { conversationId: one.conv.id, customerId, body: 'reply', toE164: PHONE, dedupeKey: 'fd-text:x' }, { status: 'queued' }, hours(0.1)),
    );
    const two = await receive(hours(0.2), 'two');
    const three = await receive(hours(0.3), 'three');
    const rows = await withTenant(pools, ctx, (tx) => listUnansweredInbound(tx, ctx, one.conv.id));
    expect(rows.map((r) => r.id)).toEqual([two.messageId, three.messageId]);
    expect(rows.map((r) => r.body)).toEqual(['two', 'three']);
  });

  test('lastTeamReplyAt ignores fd-text assistant texts and returns a non-assistant outbound', async () => {
    const ctx = ctxFor(seed.a);
    const { conv } = await receive(T0);
    const customerId = await customer();
    expect(await withTenant(pools, ctx, (tx) => lastTeamReplyAt(tx, ctx, conv.id))).toBeNull();
    await withTenant(pools, ctx, (tx) =>
      insertAssistantText(tx, ctx, { conversationId: conv.id, customerId, body: 'bot', toE164: PHONE, dedupeKey: 'fd-text:a' }, { status: 'queued' }, hours(0.1)),
    );
    expect(await withTenant(pools, ctx, (tx) => lastTeamReplyAt(tx, ctx, conv.id))).toBeNull();
    await withTenant(pools, ctx, (tx) =>
      insertAssistantText(tx, ctx, { conversationId: conv.id, customerId, body: 'person', toE164: PHONE, dedupeKey: 'team:1' }, { status: 'queued' }, hours(0.2)),
    );
    const at = await withTenant(pools, ctx, (tx) => lastTeamReplyAt(tx, ctx, conv.id));
    expect(at?.toISOString()).toBe(hours(0.2).toISOString());
    const texts = await withTenant(pools, ctx, (tx) => listConversationTexts(tx, ctx, conv.id, 10));
    expect(texts.map((t) => [t.body, t.assistant])).toEqual([
      ['hello', false],
      ['bot', true],
      ['person', false],
    ]);
  });

  test('insertAssistantText is idempotent per dedupeKey', async () => {
    const ctx = ctxFor(seed.a);
    const { conv } = await receive(T0);
    const customerId = await customer();
    const input = { conversationId: conv.id, customerId, body: 'bot', toE164: PHONE, dedupeKey: 'fd-text:same' };
    const first = await withTenant(pools, ctx, (tx) => insertAssistantText(tx, ctx, input, { status: 'queued' }, hours(0.1)));
    const second = await withTenant(pools, ctx, (tx) => insertAssistantText(tx, ctx, input, { status: 'queued' }, hours(0.2)));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const rows = await withTenant(pools, ctx, (tx) => tx.select().from(messages).where(eq(messages.dedupeKey, 'fd-text:same')));
    expect(rows).toHaveLength(1);
  });

  test('two racing insertAssistantText calls with one fd- key insert once (review note 35)', async () => {
    const ctx = ctxFor(seed.a);
    const { conv } = await receive(T0);
    const customerId = await customer();
    const input = { conversationId: conv.id, customerId, body: 'bot', toE164: PHONE, dedupeKey: 'fd-text:race' };
    const results = await Promise.all(
      [0.1, 0.2, 0.3].map((h) => withTenant(pools, ctx, (tx) => insertAssistantText(tx, ctx, input, { status: 'queued' }, hours(h)))),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const rows = await withTenant(pools, ctx, (tx) => tx.select().from(messages).where(eq(messages.dedupeKey, 'fd-text:race')));
    expect(rows).toHaveLength(1);
  });

  test('frontDeskTextsOn is false unless both settings are on', async () => {
    const ctx = ctxFor(seed.a);
    const set = (v: { frontDeskEnabled: boolean; frontDeskTexts: boolean }) =>
      withTenant(pools, ctx, (tx) => tx.update(companySettings).set(v).where(eq(companySettings.companyId, ctx.companyId)));
    const read = () => withTenant(pools, ctx, (tx) => frontDeskTextsOn(tx, ctx));
    await set({ frontDeskEnabled: false, frontDeskTexts: true });
    expect(await read()).toBe(false);
    await set({ frontDeskEnabled: true, frontDeskTexts: false });
    expect(await read()).toBe(false);
    await set({ frontDeskEnabled: true, frontDeskTexts: true });
    expect(await read()).toBe(true);
  });
});

/** Any customer of company A (the seed has none), made through the owner connection. */
async function customer(): Promise<string> {
  const ctx = ctxFor(seed.a);
  const { customers } = await import('../src/schema/index.ts');
  return withTenant(pools, ctx, async (tx) => {
    const [row] = await tx
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Pat Lee', phones: [{ e164: PHONE, label: 'mobile' }] })
      .returning({ id: customers.id });
    return row!.id;
  });
}
