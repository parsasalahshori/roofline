import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  calls,
  companyPhoneNumbers,
  conversations,
  conversationTurns,
  customers,
  encrypt,
  memberships,
  messages,
  optOuts,
  textingRegistrations,
  type ToolCallRecord,
} from '@roofline/db';
import type { ConversationDetail, ConversationPage } from '@roofline/shared';
import { Actors, inCompany, NO_UUID, NOT_FOUND } from '../crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';
import { DAYTIME, HOUR, OPTED_OUT } from '../sms-helpers.ts';

/*
 * D1 Task 18, conversations: the inbox list, detail, reply (through the send gate), handling and read.
 * Database-backed: CI runs it. Nothing leaves the process (FakeSmsAdapter).
 */

const A_NUMBER = '+14025550100';
const TOKEN = 'test-subaccount-token-a';
const TEXTABLE = '+14025550101';
const OPTED_OUT_NUMBER = '+14025550103';
const UNKNOWN_NUMBER = '+14025550777';
const BASE = '/api/conversations';

let t: TestApp;
let who: Actors;
let sidCounter = 0;

const idA = () => t.seed.a.companyId;
const idB = () => t.seed.b.companyId;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(DAYTIME);
  await t.deps.pools.system
    .insert(companyPhoneNumbers)
    .values({ companyId: idA(), e164: A_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idA()));
});

type SeedCustomer = { name: string; phone?: string; createdBy?: string | null; consent?: 'attested' | 'none' };

async function seedCustomer(company: 'a' | 'b', c: SeedCustomer): Promise<string> {
  const companyId = company === 'a' ? idA() : idB();
  return inCompany(t, companyId, async (tx) => {
    const [row] = await tx
      .insert(customers)
      .values({
        companyId,
        displayName: c.name,
        firstName: c.name.split(' ')[0] ?? c.name,
        phones: c.phone === undefined ? [] : [{ e164: c.phone, label: 'mobile', primary: true }],
        smsConsentStatus: c.consent ?? 'attested',
        createdByUserId: c.createdBy ?? null,
      })
      .returning({ id: customers.id });
    return row!.id;
  });
}

type SeedConversation = {
  company?: 'a' | 'b';
  channel?: 'voice' | 'sms';
  customerId?: string | null;
  phone?: string;
  outcome?: 'booked' | 'spam' | 'message' | null;
  unread?: number;
  lastMessageAt?: Date;
};

let phoneSeq = 0;

async function seedConversation(o: SeedConversation = {}): Promise<string> {
  const companyId = o.company === 'b' ? idB() : idA();
  return inCompany(t, companyId, async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({
        companyId,
        channel: o.channel ?? 'sms',
        customerId: o.customerId ?? null,
        phoneE164: o.phone ?? `+1402556${String(++phoneSeq).padStart(4, '0')}`,
        companyNumberE164: A_NUMBER,
        outcome: o.outcome ?? null,
        unreadCount: o.unread ?? 0,
        lastMessageAt: o.lastMessageAt ?? t.clock.now(),
      })
      .returning({ id: conversations.id });
    return row!.id;
  });
}

async function seedCall(
  conversationId: string,
  o: { status?: 'ended' | 'transferred' | 'ai'; transcriptStored?: boolean; recordingStatus?: 'none' | 'stored'; transferResult?: 'answered' | 'none' } = {},
): Promise<string> {
  const [row] = await inCompany(t, idA(), (tx) =>
    tx
      .insert(calls)
      .values({
        companyId: idA(),
        conversationId,
        callSid: `CA${String(++sidCounter).padStart(32, '0')}`,
        fromE164: UNKNOWN_NUMBER,
        toE164: A_NUMBER,
        status: o.status ?? 'ended',
        transcriptStored: o.transcriptStored ?? true,
        recordingStatus: o.recordingStatus ?? 'stored',
        recordingKey: o.recordingStatus === 'none' ? null : `rec/${sidCounter}.mp3`,
        transferResult: o.transferResult ?? 'none',
      })
      .returning({ id: calls.id }),
  );
  return row!.id;
}

async function seedTurn(
  conversationId: string,
  position: number,
  o: { text?: string; callId?: string | null; toolCalls?: ToolCallRecord[] } = {},
): Promise<void> {
  await inCompany(t, idA(), (tx) =>
    tx.insert(conversationTurns).values({
      companyId: idA(),
      conversationId,
      callId: o.callId ?? null,
      position,
      speaker: position % 2 === 0 ? 'assistant' : 'caller',
      text: o.text ?? `line ${position}`,
      toolCalls: o.toolCalls ?? null,
    }),
  );
}

const setOnCall = (userId: string, order: number | null) =>
  t.deps.pools.system
    .update(memberships)
    .set({ onCallOrder: order })
    .where(and(eq(memberships.companyId, idA()), eq(memberships.userId, userId)));

const ids = (page: ConversationPage) => page.items.map((i) => i.id).sort();

describe('GET /api/conversations', () => {
  test('rep sees only conversations of their customers', async () => {
    const rep = await who.as('rep');
    const mine = await seedCustomer('a', { name: 'Mine Customer', createdBy: who.user('rep').userId });
    const theirs = await seedCustomer('a', { name: 'Theirs Customer', createdBy: who.user('otherRep').userId });
    const c1 = await seedConversation({ customerId: mine });
    await seedConversation({ customerId: theirs });
    await setOnCall(who.user('rep').userId, null);
    const res = await rep.get(BASE);
    expect(res.status).toBe(200);
    expect(ids(res.body as ConversationPage)).toEqual([c1]);
    expect((await rep.get(`${BASE}/${c1}`)).status).toBe(200);
  });

  test('rep sees unknown-number conversations only when on call', async () => {
    const rep = await who.as('rep');
    const unknown = await seedConversation({ customerId: null });
    expect(ids((await rep.get(BASE)).body)).toEqual([]);
    expect((await rep.get(`${BASE}/${unknown}`)).status).toBe(404);
    await setOnCall(who.user('rep').userId, 1);
    expect(ids((await rep.get(BASE)).body)).toEqual([unknown]);
    expect((await rep.get(`${BASE}/${unknown}`)).status).toBe(200);
  });

  test('owner sees all and filters narrow (needs_attention, booked, messages, spam)', async () => {
    const owner = await who.as('owner');
    const customer = await seedCustomer('a', { name: 'Nina Customer', phone: TEXTABLE });
    const booked = await seedConversation({ channel: 'voice', customerId: customer, outcome: 'booked' });
    const unread = await seedConversation({ channel: 'sms', customerId: customer, unread: 2, phone: TEXTABLE });
    const spam = await seedConversation({ channel: 'voice', outcome: 'spam', unread: 1, phone: '+14025550888' });
    const quietVoice = await seedConversation({ channel: 'voice', phone: '+14025550999' });

    expect(ids((await owner.get(BASE)).body)).toEqual([booked, unread, quietVoice].sort());
    expect(ids((await owner.get(`${BASE}?filter=all`)).body)).toEqual([booked, unread, quietVoice].sort());
    expect(ids((await owner.get(`${BASE}?filter=booked`)).body)).toEqual([booked]);
    expect(ids((await owner.get(`${BASE}?filter=messages`)).body)).toEqual([unread]);
    expect(ids((await owner.get(`${BASE}?filter=spam`)).body)).toEqual([spam]);
    const attention = (await owner.get(`${BASE}?filter=needs_attention`)).body as ConversationPage;
    expect(ids(attention)).toEqual([unread]);
    expect(attention.items[0]).toMatchObject({ needsAttention: true, unreadCount: 2, name: 'Nina Customer' });

    const bad = await owner.get(`${BASE}?filter=nope`);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ field: 'filter' });
  });

  test('a live call shows on its conversation', async () => {
    const owner = await who.as('owner');
    const convo = await seedConversation({ channel: 'voice' });
    const callId = await seedCall(convo, { status: 'ai', recordingStatus: 'none' });
    const item = ((await owner.get(BASE)).body as ConversationPage).items[0]!;
    expect(item.liveCall).toMatchObject({ callId, status: 'ai' });
  });

  test('cursor pages without repeats', async () => {
    const owner = await who.as('owner');
    const made: string[] = [];
    for (let i = 0; i < 35; i += 1) {
      // Several share a timestamp, so the id tie-break is what keeps pages stable.
      made.push(await seedConversation({ phone: `+1402555${String(2000 + i)}`, lastMessageAt: new Date(DAYTIME.getTime() - Math.floor(i / 3) * 1000) }));
    }
    const first = (await owner.get(BASE)).body as ConversationPage;
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    const second = (await owner.get(`${BASE}?cursor=${encodeURIComponent(first.nextCursor!)}`)).body as ConversationPage;
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(all).size).toBe(35);
    expect([...all].sort()).toEqual([...made].sort());
    const times = [...first.items, ...second.items].map((i) => i.lastMessageAt);
    expect(times).toEqual([...times].sort().reverse());

    const bad = await owner.get(`${BASE}?cursor=garbage`);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ field: 'cursor' });
  });
});

describe('GET /api/conversations/:id', () => {
  test('detail hides turn text when not stored', async () => {
    const owner = await who.as('owner');
    const convo = await seedConversation({ channel: 'voice' });
    const kept = await seedCall(convo, { transcriptStored: true });
    const dropped = await seedCall(convo, { transcriptStored: false });
    await seedTurn(convo, 1, { text: 'hello there', callId: kept });
    await seedTurn(convo, 2, { text: 'secret words', callId: dropped });
    await seedTurn(convo, 3, { text: '', callId: kept });
    await seedTurn(convo, 4, {
      text: 'done',
      callId: kept,
      toolCalls: [{ name: 'book_inspection', input: {}, result: 'ok', ok: true }],
    });
    const res = await owner.get(`${BASE}/${convo}`);
    expect(res.status).toBe(200);
    const detail = res.body as ConversationDetail;
    expect(detail.turns.map((x) => x.text)).toEqual(['hello there', null, null, 'done']);
    expect(detail.turns[3]!.actions).toEqual([{ tool: 'book_inspection', ok: true, label: 'Booked an inspection', link: null }]);
    expect(detail.canReply).toBe(false);
    expect(detail.calls).toHaveLength(2);
  });

  test('canPlayRecording per role (owner true, rep own-customer true, rep transferred call false)', async () => {
    const rep = await who.as('rep');
    const owner = await who.as('owner');
    const mine = await seedCustomer('a', { name: 'Mine Customer', createdBy: who.user('rep').userId });
    const convo = await seedConversation({ channel: 'voice', customerId: mine });
    const plain = await seedCall(convo);
    const moved = await seedCall(convo, { status: 'transferred', transferResult: 'answered' });
    const byCall = (d: ConversationDetail, id: string) => d.calls.find((c) => c.id === id)!.canPlayRecording;
    const asOwner = (await owner.get(`${BASE}/${convo}`)).body as ConversationDetail;
    expect(byCall(asOwner, plain)).toBe(true);
    expect(byCall(asOwner, moved)).toBe(true);
    const asRep = (await rep.get(`${BASE}/${convo}`)).body as ConversationDetail;
    expect(byCall(asRep, plain)).toBe(true);
    expect(byCall(asRep, moved)).toBe(false);
  });
});

describe('POST /api/conversations/:id/reply', () => {
  test('reply goes through the gate as informational, sets handledBy team and teamUntil = now+2h, message row queued', async () => {
    const owner = await who.as('owner');
    const customer = await seedCustomer('a', { name: 'Nina Customer', phone: TEXTABLE });
    const convo = await seedConversation({ channel: 'sms', customerId: customer, phone: TEXTABLE, unread: 1 });
    const res = await owner.post(`${BASE}/${convo}/reply`).send({ body: '  We can come Friday.  ' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    const rows = await inCompany(t, idA(), (tx) => tx.select().from(messages).where(eq(messages.conversationId, convo)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: res.body.id,
      direction: 'out',
      purpose: 'informational',
      body: 'We can come Friday.',
      toE164: TEXTABLE,
    });
    expect(rows[0]!.dedupeKey).toMatch(/^fd-reply:/);
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toMatchObject({ to: TEXTABLE, body: 'We can come Friday.' });
    const [row] = await inCompany(t, idA(), (tx) => tx.select().from(conversations).where(eq(conversations.id, convo)));
    expect(row!.handledBy).toBe('team');
    expect(row!.teamUntil?.toISOString()).toBe(new Date(DAYTIME.getTime() + 2 * HOUR).toISOString());
  });

  test('reply validates the body and only works on texts', async () => {
    const owner = await who.as('owner');
    const customer = await seedCustomer('a', { name: 'Nina Customer', phone: TEXTABLE });
    const sms = await seedConversation({ channel: 'sms', customerId: customer, phone: TEXTABLE });
    const voice = await seedConversation({ channel: 'voice', customerId: customer, phone: TEXTABLE });
    for (const body of ['', '   ', 'x'.repeat(1601)]) {
      const res = await owner.post(`${BASE}/${sms}/reply`).send({ body });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ field: 'body' });
    }
    expect((await owner.post(`${BASE}/${voice}/reply`).send({ body: 'hi' })).status).toBe(409);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('reply to a blocked/unsubscribed customer is not sent', async () => {
    const owner = await who.as('owner');
    const customer = await seedCustomer('a', { name: 'Pia Customer', phone: OPTED_OUT_NUMBER });
    await inCompany(t, idA(), async (tx) => {
      await tx.insert(optOuts).values({ companyId: idA(), phoneE164: OPTED_OUT_NUMBER, keyword: 'stop', at: DAYTIME, createdAt: DAYTIME, updatedAt: DAYTIME });
    });
    const convo = await seedConversation({ channel: 'sms', customerId: customer, phone: OPTED_OUT_NUMBER });
    const res = await owner.post(`${BASE}/${convo}/reply`).send({ body: 'Hello again' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('blocked');
    expect(t.sms.sent).toHaveLength(0);
    const [row] = await inCompany(t, idA(), (tx) => tx.select().from(messages).where(eq(messages.id, res.body.id)));
    expect(row).toMatchObject({ status: 'blocked' });
    expect(row!.blockReason).toBe(OPTED_OUT);
  });
});

describe('handling and read', () => {
  test('handling switch', async () => {
    const owner = await who.as('owner');
    const convo = await seedConversation({ channel: 'sms' });
    const toTeam = await owner.post(`${BASE}/${convo}/handling`).send({ by: 'team' });
    expect(toTeam.status).toBe(200);
    expect(toTeam.body).toEqual({ id: convo, handledBy: 'team', teamUntil: new Date(DAYTIME.getTime() + 2 * HOUR).toISOString() });
    const toAi = await owner.post(`${BASE}/${convo}/handling`).send({ by: 'assistant' });
    expect(toAi.body).toEqual({ id: convo, handledBy: 'assistant', teamUntil: null });
    const [row] = await inCompany(t, idA(), (tx) => tx.select().from(conversations).where(eq(conversations.id, convo)));
    expect(row).toMatchObject({ handledBy: 'assistant', teamUntil: null });
    const bad = await owner.post(`${BASE}/${convo}/handling`).send({ by: 'robot' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ field: 'by' });
  });

  test('read clears unread', async () => {
    const owner = await who.as('owner');
    const convo = await seedConversation({ unread: 3 });
    expect((await owner.post(`${BASE}/${convo}/read`)).status).toBe(200);
    const [row] = await inCompany(t, idA(), (tx) => tx.select().from(conversations).where(eq(conversations.id, convo)));
    expect(row!.unreadCount).toBe(0);
  });
});

describe('isolation', () => {
  test('cross-tenant 404 on GET detail, reply, handling, read', async () => {
    const ownerA = await who.as('owner', 'a');
    const customerB = await seedCustomer('b', { name: 'Bee Customer', phone: TEXTABLE });
    const inB = await seedConversation({ company: 'b', channel: 'sms', customerId: customerB, phone: TEXTABLE, unread: 2 });
    for (const res of [
      await ownerA.get(`${BASE}/${inB}`),
      await ownerA.post(`${BASE}/${inB}/reply`).send({ body: 'hi' }),
      await ownerA.post(`${BASE}/${inB}/handling`).send({ by: 'team' }),
      await ownerA.post(`${BASE}/${inB}/read`),
      await ownerA.get(`${BASE}/not-a-uuid`),
      await ownerA.get(`${BASE}/${NO_UUID}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
    expect(t.sms.sent).toHaveLength(0);
    expect(ids((await ownerA.get(BASE)).body)).toEqual([]);
    const [row] = await inCompany(t, idB(), (tx) => tx.select().from(conversations).where(eq(conversations.id, inB)));
    expect(row).toMatchObject({ unreadCount: 2, handledBy: 'assistant' });
  });
});
