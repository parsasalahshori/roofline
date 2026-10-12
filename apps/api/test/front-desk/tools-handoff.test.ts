import { beforeEach, describe, expect, test } from 'vitest';
import { companySettings, conversations, createCustomer, type TenantContext } from '@roofline/db';
import { DEFAULT_WORK_HOURS } from '@roofline/shared';
import { takeMessage } from '../../src/front-desk/tools/message.ts';
import { endCall } from '../../src/front-desk/tools/end.ts';
import { transferToPerson } from '../../src/front-desk/tools/transfer.ts';
import type { ConversationState } from '../../src/front-desk/engine-types.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { DAYTIME } from '../sms-helpers.ts';

/*
 * D1 Task 9: transfer_to_person and end_call. The real handlers run against the database; nothing leaves the
 * process. Database-backed: CI runs it.
 */

let t: TestApp;
const idA = () => t.seed.a.companyId;
/** 22:00 on Tuesday 13 October 2026 in Chicago (CDT): outside the default work hours. */
const AFTER_HOURS = new Date('2026-10-14T03:00:00.000Z');

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  await inCompany(t, idA(), (tx) =>
    tx
      .insert(companySettings)
      .values({ companyId: idA(), workHours: DEFAULT_WORK_HOURS })
      .onConflictDoUpdate({ target: companySettings.companyId, set: { workHours: DEFAULT_WORK_HOURS } }),
  );
});

async function putOnCall(count: number) {
  const q = t.deps.pools.system.$client;
  const members = [t.seed.a.owner, t.seed.a.office].slice(0, count);
  for (const [i, m] of members.entries()) {
    await q.query(
      'update memberships set transfer_phone_e164 = $1, on_call_order = $2 where company_id = $3 and user_id = $4',
      [`+1402555020${String(i)}`, i, idA(), m.userId],
    );
  }
}

async function makeConversation(): Promise<ConversationState> {
  const conversationId = await inCompany(t, idA(), async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({ companyId: idA(), channel: 'voice', phoneE164: '+14025550777', companyNumberE164: '+14025550100', status: 'active' })
      .returning({ id: conversations.id });
    return row!.id;
  });
  return {
    companyId: idA(),
    conversationId,
    channel: 'voice',
    phone: '+14025550777',
    callId: null,
    identity: 'unknown',
    customerId: null,
    shownIds: new Set<string>(),
    history: [],
    companyBlock: '',
    repName: null,
    startedAt: t.clock.now(),
    turns: 0,
    failedUnderstanding: 0,
    askedForPersonCount: 0,
    taskInProgress: false,
    nextPosition: 0,
    mode: 'normal',
    modelErrors: 0,
  } as ConversationState;
}

const transfer = (conversation: ConversationState, reason: 'asked' | 'leak' | 'danger' | 'angry' | 'trade_caller' | 'not_understood') =>
  transferToPerson({ deps: t.deps, companyId: idA(), conversation, now: t.clock.now() }, { reason, summary: 'Caller wants a person' });

describe('transfer_to_person', () => {
  test('transfer plan rings all on-call members in work hours', async () => {
    await putOnCall(2);
    const res = await transfer(await makeConversation(), 'asked');
    expect(res).toMatchObject({ ok: true, action: 'transfer_ring_all' });
    expect(res.forModel).not.toMatch(/\+?\d{7,}/);
  });

  test('after hours and not urgent gives message mode', async () => {
    await putOnCall(2);
    t.clock.set(AFTER_HOURS);
    const res = await transfer(await makeConversation(), 'asked');
    expect(res.action).toBe('message');
    expect(res.forModel).toContain('take_message');
  });

  test('after hours leak reason gives ring_each', async () => {
    await putOnCall(2);
    t.clock.set(AFTER_HOURS);
    const res = await transfer(await makeConversation(), 'leak');
    expect(res.action).toBe('transfer_ring_each');
  });

  test('after hours, an urgent message earlier in the conversation makes a plain request ring each', async () => {
    await putOnCall(2);
    t.clock.set(AFTER_HOURS);
    const sys: TenantContext = { companyId: idA(), userId: null, role: 'system', canApproveSpend: false };
    const customerId = await inCompany(t, idA(), async (tx) => (await createCustomer(tx, sys, { displayName: 'Nina Test' }, { now: t.clock.now() })).id);
    const conv = { ...(await makeConversation()), customerId, identity: 'matched' as const };
    const ctx = { deps: t.deps, companyId: idA(), conversation: conv, now: t.clock.now() };
    expect((await transfer(conv, 'asked')).action).toBe('message');
    await takeMessage(ctx, { reason: 'Water coming in', urgent: true, callbackWhen: null, name: null });
    expect((await transfer(conv, 'asked')).action).toBe('transfer_ring_each');
  });

  test('no on-call members gives message mode', async () => {
    const res = await transfer(await makeConversation(), 'asked');
    expect(res.action).toBe('message');
  });

  test('asked increments askedForPersonCount, not_understood increments failedUnderstanding', async () => {
    const conv = await makeConversation();
    await transfer(conv, 'asked');
    expect(conv.askedForPersonCount).toBe(1);
    expect(conv.failedUnderstanding).toBe(0);
    await transfer(conv, 'not_understood');
    expect(conv.askedForPersonCount).toBe(1);
    expect(conv.failedUnderstanding).toBe(1);
    await transfer(conv, 'leak');
    expect(conv.askedForPersonCount).toBe(1);
    expect(conv.failedUnderstanding).toBe(1);
  });
});

describe('end_call', () => {
  test('end_call returns end_spam action', async () => {
    const res = await endCall(
      { deps: t.deps, companyId: idA(), conversation: await makeConversation(), now: t.clock.now() },
      { reason: 'spam' },
    );
    expect(res).toMatchObject({ ok: true, action: 'end_spam' });
  });
});
