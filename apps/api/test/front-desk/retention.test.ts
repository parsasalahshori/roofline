import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  calls,
  companySettings,
  conversations,
  conversationTurns,
  customers,
  setArchived,
  withTenant,
  type TenantContext,
  type ToolCallRecord,
  type Tx,
} from '@roofline/db';
import { sweepCompanyRetention, purgeCustomerConversations } from '../../src/front-desk/retention.ts';
import { fdRetention } from '../../src/jobs/scheduler/fd-retention.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

/*
 * Task 16: the Front Desk retention sweep and the customer purge (Ruling DX). Database-backed (CI only).
 */

const DAY = 86_400_000;
const NOW = new Date('2026-10-12T12:00:00Z');
const TEST_CALLER = '+14025550111';
const BYTES = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00]);
const TOOL_CALLS: ToolCallRecord[] = [{ name: 'lookup', input: { q: 1 }, result: 'secret', ok: true }];

let t: TestApp;
let seq = 0;

const ctxFor = (companyId: string): TenantContext => ({ companyId, role: 'system', userId: null, canApproveSpend: false });
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const inTenant = <T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> => withTenant(t.deps.pools, ctxFor(companyId), fn);

beforeEach(async () => {
  t = await makeTestApp({ TWILIO_TEST_CALLER_NUMBER: TEST_CALLER });
  seq = 0;
});

async function setRetention(companyId: string, recordingRetentionDays: number, transcriptRetentionDays: number): Promise<void> {
  await inTenant(companyId, (tx) =>
    tx
      .insert(companySettings)
      .values({ companyId, recordingRetentionDays, transcriptRetentionDays })
      .onConflictDoUpdate({ target: companySettings.companyId, set: { recordingRetentionDays, transcriptRetentionDays } }),
  );
}

async function addConversation(
  companyId: string,
  o: { outcome?: 'spam' | null; customerId?: string | null; summary?: string } = {},
): Promise<string> {
  seq++;
  const [row] = await inTenant(companyId, (tx) =>
    tx
      .insert(conversations)
      .values({
        companyId,
        channel: 'voice',
        customerId: o.customerId ?? null,
        phoneE164: `+1402555${String(1000 + seq)}`,
        companyNumberE164: '+14025550200',
        summary: o.summary ?? `summary ${seq}`,
        outcome: o.outcome ?? 'booked',
      })
      .returning({ id: conversations.id }),
  );
  return row!.id;
}

/** A recorded call (the object is put into the store first). Returns its id and key. */
async function addCall(
  companyId: string,
  o: { startedAt: Date; spamReason?: string | null; conversationId?: string | null; fromE164?: string },
): Promise<{ id: string; key: string }> {
  seq++;
  const key = `recordings/${companyId}/call-${seq}.mp3`;
  await t.objectStore.put(key, BYTES, 'audio/mpeg');
  const [row] = await inTenant(companyId, (tx) =>
    tx
      .insert(calls)
      .values({
        companyId,
        callSid: `CA${String(seq).padStart(32, '0')}`,
        fromE164: o.fromE164 ?? `+1402555${String(2000 + seq)}`,
        toE164: '+14025550200',
        conversationId: o.conversationId === undefined ? null : o.conversationId,
        startedAt: o.startedAt,
        recordingKey: key,
        recordingStatus: 'stored',
        spamReason: o.spamReason ?? null,
      })
      .returning({ id: calls.id }),
  );
  return { id: row!.id, key };
}

async function addTurn(companyId: string, conversationId: string, at: Date, position = 1): Promise<string> {
  const [row] = await inTenant(companyId, (tx) =>
    tx
      .insert(conversationTurns)
      .values({
        companyId,
        conversationId,
        position,
        speaker: 'caller',
        text: 'my roof is leaking',
        at,
        toolCalls: TOOL_CALLS,
        model: 'test-model',
        inputTokens: 42,
      })
      .returning({ id: conversationTurns.id }),
  );
  return row!.id;
}

const callRow = async (companyId: string, id: string) =>
  (await inTenant(companyId, (tx) => tx.select().from(calls).where(eq(calls.id, id))))[0]!;
const turnRow = async (companyId: string, id: string) =>
  (await inTenant(companyId, (tx) => tx.select().from(conversationTurns).where(eq(conversationTurns.id, id))))[0]!;
const deletes = () => t.objectStore.calls.filter((c) => c.method === 'delete');

describe('Front Desk retention', () => {
  test('boundaries by days', async () => {
    const a = t.seed.a.companyId;
    await setRetention(a, 30, 60);
    const callA = await addCall(a, { startedAt: ago(30 * DAY) });
    const callB = await addCall(a, { startedAt: ago(30 * DAY + 1) });
    const convA = await addConversation(a);
    const convB = await addConversation(a);
    const turnA = await addTurn(a, convA, ago(60 * DAY));
    const turnB = await addTurn(a, convB, ago(60 * DAY + 1));

    const result = await sweepCompanyRetention(t.deps, a, NOW);
    expect(result).toEqual({ recordingsDeleted: 1, turnsBlanked: 1 });

    const rowA = await callRow(a, callA.id);
    expect(rowA.recordingStatus).toBe('stored');
    expect(rowA.recordingKey).toBe(callA.key);
    expect(deletes().some((c) => c.key === callA.key)).toBe(false);

    const rowB = await callRow(a, callB.id);
    expect(deletes()).toContainEqual({ method: 'delete', key: callB.key });
    expect(rowB.recordingStatus).toBe('deleted');
    expect(rowB.recordingKey).toBeNull();

    expect((await turnRow(a, turnA)).text).toBe('my roof is leaking');
    expect((await turnRow(a, turnB)).text).toBe('');
  });

  test('spam is swept at 7 days', async () => {
    const a = t.seed.a.companyId;
    await setRetention(a, 90, 365);
    const spamOld = await addCall(a, { startedAt: ago(8 * DAY), spamReason: 'assistant_spam' });
    const normalOld = await addCall(a, { startedAt: ago(8 * DAY) });
    const spamFresh = await addCall(a, { startedAt: ago(6 * DAY), spamReason: 'assistant_spam' });
    const spamConv = await addConversation(a, { outcome: 'spam' });
    const normalConv = await addConversation(a);
    const freshSpamConv = await addConversation(a, { outcome: 'spam' });
    const spamTurn = await addTurn(a, spamConv, ago(8 * DAY));
    const normalTurn = await addTurn(a, normalConv, ago(8 * DAY));
    const freshSpamTurn = await addTurn(a, freshSpamConv, ago(6 * DAY));

    await sweepCompanyRetention(t.deps, a, NOW);

    expect((await callRow(a, spamOld.id)).recordingStatus).toBe('deleted');
    expect((await callRow(a, normalOld.id)).recordingStatus).toBe('stored');
    expect((await callRow(a, spamFresh.id)).recordingStatus).toBe('stored');
    expect((await turnRow(a, spamTurn)).text).toBe('');
    expect((await turnRow(a, normalTurn)).text).toBe('my roof is leaking');
    expect((await turnRow(a, freshSpamTurn)).text).toBe('my roof is leaking');
  });

  test('recording_retention_days = 0 expires every existing recording now, spam or not', async () => {
    const a = t.seed.a.companyId;
    await setRetention(a, 0, 365);
    const old = await addCall(a, { startedAt: ago(400 * DAY) });
    const recent = await addCall(a, { startedAt: ago(60_000) });
    const spam = await addCall(a, { startedAt: ago(60_000), spamReason: 'assistant_spam' });
    const testCall = await addCall(a, { startedAt: ago(DAY), conversationId: null, fromE164: TEST_CALLER });
    const result = await sweepCompanyRetention(t.deps, a, NOW);
    expect(result.recordingsDeleted).toBe(3);
    for (const call of [old, recent, spam]) {
      const row = await callRow(a, call.id);
      expect(row.recordingStatus).toBe('deleted');
      expect(row.recordingKey).toBeNull();
      expect(deletes()).toContainEqual({ method: 'delete', key: call.key });
    }
    expect((await callRow(a, testCall.id)).recordingStatus).toBe('stored');
  });

  test('turn text is blanked, metadata and summaries kept', async () => {
    const a = t.seed.a.companyId;
    await setRetention(a, 90, 60);
    const conv = await addConversation(a, { summary: 'Leak repair quote', outcome: 'spam' });
    const turn = await addTurn(a, conv, ago(100 * DAY), 3);
    const before = await turnRow(a, turn);

    await sweepCompanyRetention(t.deps, a, NOW);

    const after = await turnRow(a, turn);
    expect(after.text).toBe('');
    expect(after.toolCalls).toEqual([{ name: 'lookup', ok: true }]);
    expect(after.model).toBe('test-model');
    expect(after.inputTokens).toBe(42);
    expect(after.position).toBe(3);
    expect(after.speaker).toBe('caller');
    expect(after.at).toEqual(before.at);
    const [c] = await inTenant(a, (tx) => tx.select().from(conversations).where(eq(conversations.id, conv)));
    expect(c!.summary).toBe('Leak repair quote');
    expect(c!.outcome).toBe('spam');
  });

  test('forwarding-test calls are skipped', async () => {
    const a = t.seed.a.companyId;
    await setRetention(a, 30, 60);
    const test = await addCall(a, { startedAt: ago(200 * DAY), conversationId: null, fromE164: TEST_CALLER });
    const real = await addCall(a, { startedAt: ago(200 * DAY), conversationId: null });
    await sweepCompanyRetention(t.deps, a, NOW);
    const testRow = await callRow(a, test.id);
    expect(testRow.recordingStatus).toBe('stored');
    expect(testRow.recordingKey).toBe(test.key);
    expect(deletes().some((c) => c.key === test.key)).toBe(false);
    expect((await callRow(a, real.id)).recordingStatus).toBe('deleted');
  });

  test('is idempotent', async () => {
    const a = t.seed.a.companyId;
    await setRetention(a, 30, 60);
    await addCall(a, { startedAt: ago(100 * DAY) });
    const conv = await addConversation(a);
    await addTurn(a, conv, ago(100 * DAY));

    const first = await sweepCompanyRetention(t.deps, a, NOW);
    expect(first).toEqual({ recordingsDeleted: 1, turnsBlanked: 1 });
    const deleteCount = deletes().length;
    const second = await sweepCompanyRetention(t.deps, a, NOW);
    expect(second).toEqual({ recordingsDeleted: 0, turnsBlanked: 0 });
    expect(deletes()).toHaveLength(deleteCount);
  });

  test('sweeping company A never touches company B', async () => {
    const a = t.seed.a.companyId;
    const b = t.seed.b.companyId;
    await setRetention(a, 30, 60);
    await setRetention(b, 30, 60);
    const callB = await addCall(b, { startedAt: ago(100 * DAY) });
    const convB = await addConversation(b);
    const turnB = await addTurn(b, convB, ago(100 * DAY));
    await addCall(a, { startedAt: ago(100 * DAY) });

    await sweepCompanyRetention(t.deps, a, NOW);

    const row = await callRow(b, callB.id);
    expect(row.recordingStatus).toBe('stored');
    expect(row.recordingKey).toBe(callB.key);
    expect((await turnRow(b, turnB)).text).toBe('my roof is leaking');
    expect(deletes().some((c) => c.key === callB.key)).toBe(false);
  });

  test('fans out across companies and isolates failures', async () => {
    const a = t.seed.a.companyId;
    const b = t.seed.b.companyId;
    await setRetention(a, 30, 60);
    await setRetention(b, 30, 60);
    const callA = await addCall(a, { startedAt: ago(100 * DAY) });
    const callB = await addCall(b, { startedAt: ago(100 * DAY) });

    await fdRetention(t.deps, NOW);
    expect((await callRow(a, callA.id)).recordingStatus).toBe('deleted');
    expect((await callRow(b, callB.id)).recordingStatus).toBe('deleted');

    const failing = await addCall(a, { startedAt: ago(100 * DAY) });
    t.objectStore.failNext(1);
    await expect(fdRetention(t.deps, NOW)).resolves.not.toThrow();
    const stuck = await callRow(a, failing.id);
    expect(stuck.recordingStatus).toBe('stored');
    expect(stuck.recordingKey).toBe(failing.key);

    await fdRetention(t.deps, NOW);
    expect((await callRow(a, failing.id)).recordingStatus).toBe('deleted');
  });

  test('purgeCustomerConversations purges at once', async () => {
    const a = t.seed.a.companyId;
    await setRetention(a, 90, 365);
    const [mine, other] = await inTenant(a, (tx) =>
      tx
        .insert(customers)
        .values([
          { companyId: a, displayName: 'Purge Me' },
          { companyId: a, displayName: 'Keep Me' },
        ])
        .returning({ id: customers.id }),
    );
    const convMine = await addConversation(a, { customerId: mine!.id });
    const convOther = await addConversation(a, { customerId: other!.id });
    const callMine = await addCall(a, { startedAt: ago(1 * DAY), conversationId: convMine });
    const callOther = await addCall(a, { startedAt: ago(1 * DAY), conversationId: convOther });
    const turnMine = await addTurn(a, convMine, ago(1 * DAY));
    const turnOther = await addTurn(a, convOther, ago(1 * DAY));

    const result = await inTenant(a, (tx) => purgeCustomerConversations(tx, ctxFor(a), mine!.id, t.objectStore));
    expect(result).toEqual({ recordingsDeleted: 1, turnsBlanked: 1 });

    expect(deletes()).toContainEqual({ method: 'delete', key: callMine.key });
    const rowMine = await callRow(a, callMine.id);
    expect(rowMine.recordingStatus).toBe('deleted');
    expect(rowMine.recordingKey).toBeNull();
    const tMine = await turnRow(a, turnMine);
    expect(tMine.text).toBe('');
    expect(tMine.toolCalls).toEqual([{ name: 'lookup', ok: true }]);

    const rowOther = await callRow(a, callOther.id);
    expect(rowOther.recordingStatus).toBe('stored');
    expect(rowOther.recordingKey).toBe(callOther.key);
    expect(deletes().some((c) => c.key === callOther.key)).toBe(false);
    const tOther = await turnRow(a, turnOther);
    expect(tOther.text).toBe('my roof is leaking');
    expect(tOther.toolCalls).toEqual(TOOL_CALLS);
  });

  test('archiving a customer does not purge', async () => {
    const a = t.seed.a.companyId;
    const owner: TenantContext = { companyId: a, role: 'owner', userId: t.seed.a.owner.userId, canApproveSpend: true };
    const [cust] = await withTenant(t.deps.pools, owner, (tx) =>
      tx.insert(customers).values({ companyId: a, displayName: 'Archive Me' }).returning({ id: customers.id }),
    );
    const conv = await addConversation(a, { customerId: cust!.id });
    const call = await addCall(a, { startedAt: ago(1 * DAY), conversationId: conv });
    const turn = await addTurn(a, conv, ago(1 * DAY));

    await withTenant(t.deps.pools, owner, (tx) => setArchived(tx, owner, cust!.id, true, { now: NOW }));

    const archived = await withTenant(t.deps.pools, owner, (tx) =>
      tx.select({ archivedAt: customers.archivedAt }).from(customers).where(and(eq(customers.id, cust!.id))),
    );
    expect(archived[0]!.archivedAt).not.toBeNull();
    const row = await callRow(a, call.id);
    expect(row.recordingStatus).toBe('stored');
    expect(row.recordingKey).toBe(call.key);
    expect(deletes()).toHaveLength(0);
    expect((await turnRow(a, turn)).text).toBe('my roof is leaking');
  });
});
