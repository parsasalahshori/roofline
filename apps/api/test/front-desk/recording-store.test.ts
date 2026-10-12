import { eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { calls, companyPhoneNumbers, encrypt, textingRegistrations, withTenant, type TenantContext } from '@roofline/db';
import { storeRecording } from '../../src/jobs/recording-store.ts';
import { UnconfiguredObjectStore } from '../../src/providers/object-store.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';

/*
 * Task 12: the recording callback hook and the fd-recording-store job. Database-backed (CI only).
 * The subaccount login comes from the company's texting registration, the way the voice hooks read it.
 */

let t: TestApp;
const A_NUMBER = '+14025550200';
const CALLER = '+14025550999';
const TOKEN_A = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const PATH_BASE = '/hooks/twilio/voice/recording';
const RECORDING_SID = 'RE00000000000000000000000000000001';
const CALL_SID = 'CA00000000000000000000000000000001';
const BYTES = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00]);

const companyId = () => t.seed.a.companyId;
const ctx = (): TenantContext => ({ companyId: companyId(), role: 'system', userId: null, canApproveSpend: false });
const keyFor = (callId: string) => `recordings/${companyId()}/${callId}.mp3`;

let callId: string;

beforeEach(async () => {
  t = await makeTestApp();
  const { system } = t.deps.pools;
  await system.insert(companyPhoneNumbers).values({ companyId: companyId(), e164: A_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_A' });
  await system
    .insert(textingRegistrations)
    .values({ companyId: companyId(), subaccountSid: 'AC_test_sub', subaccountAuthTokenEncrypted: encrypt(TOKEN_A, TEST_ENCRYPTION_KEY) })
    .onConflictDoUpdate({
      target: textingRegistrations.companyId,
      set: { subaccountSid: 'AC_test_sub', subaccountAuthTokenEncrypted: encrypt(TOKEN_A, TEST_ENCRYPTION_KEY) },
    });
  const [row] = await withTenant(t.deps.pools, ctx(), (tx) =>
    tx
      .insert(calls)
      .values({ companyId: companyId(), callSid: CALL_SID, fromE164: CALLER, toE164: A_NUMBER, recordingStatus: 'recording' })
      .returning({ id: calls.id }),
  );
  callId = row!.id;
  t.callControl.putRecording(RECORDING_SID, BYTES);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const callRow = async () => {
  const rows = await withTenant(t.deps.pools, ctx(), (tx) => tx.select().from(calls).where(eq(calls.id, callId)));
  return rows[0]!;
};
const run = (attempt = 1, deps = t.deps) =>
  storeRecording(deps, { companyId: companyId(), callId, recordingSid: RECORDING_SID }, { attempt, lastAttempt: attempt >= 5 });
const puts = () => t.objectStore.calls.filter((c) => c.method === 'put');
const deletes = () => t.callControl.calls.filter((c) => c.method === 'deleteRecording');

describe('fd-recording-store job', () => {
  test('copies the recording to file storage, then deletes it at Twilio', async () => {
    await run();
    expect(await t.objectStore.get(keyFor(callId))).toEqual(BYTES);
    const row = await callRow();
    expect(row.recordingKey).toBe(keyFor(callId));
    expect(row.recordingStatus).toBe('stored');
    expect(deletes()).toHaveLength(1);
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(false);
  });

  test('a caller who objected keeps stopped_by_caller after the upload', async () => {
    await withTenant(t.deps.pools, ctx(), (tx) => tx.update(calls).set({ recordingStatus: 'stopped_by_caller' }).where(eq(calls.id, callId)));
    await run();
    const row = await callRow();
    expect(row.recordingStatus).toBe('stopped_by_caller');
    expect(row.recordingKey).toBe(keyFor(callId));
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(false);
  });

  test('running twice puts once and does not throw', async () => {
    await run();
    await run();
    expect(puts()).toHaveLength(1);
    expect((await callRow()).recordingStatus).toBe('stored');
  });

  test('a failed upload throws, and the next attempt succeeds', async () => {
    t.objectStore.failNext();
    await expect(run(1)).rejects.toThrow();
    expect((await callRow()).recordingStatus).toBe('recording');
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(true);
    await run(2);
    expect((await callRow()).recordingStatus).toBe('stored');
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(false);
  });

  test('without file storage the recording stays at Twilio and nothing throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(1, { ...t.deps, objectStore: new UnconfiguredObjectStore() });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain(callId);
    expect(deletes()).toHaveLength(0);
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(true);
    expect((await callRow()).recordingStatus).toBe('recording');
  });

  test('a job without a call id does nothing', async () => {
    await storeRecording(t.deps, { companyId: companyId() }, { attempt: 1, lastAttempt: false });
    expect(puts()).toHaveLength(0);
  });
});

describe('POST /hooks/twilio/voice/recording', () => {
  const post = (fields: Record<string, string>, signature?: string | null, path = `${PATH_BASE}?c=${companyId()}`) => {
    const sig = signature !== undefined ? signature : twilio.getExpectedTwilioSignature(TOKEN_A, BASE + path, fields);
    const req = request(t.app).post(path).type('form');
    if (sig !== null) req.set('X-Twilio-Signature', sig);
    return req.send(fields);
  };
  const base = { CallSid: CALL_SID, RecordingSid: RECORDING_SID };

  test('a completed recording saves its length and enqueues one store job', async () => {
    const res = await post({ ...base, RecordingStatus: 'completed', RecordingDuration: '42' });
    expect(res.status).toBe(204);
    const sent = t.jobs.sent.filter((j) => j.name === 'fd-recording-store');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toEqual({ companyId: companyId(), callId, recordingSid: RECORDING_SID });
    expect((await callRow()).recordingSeconds).toBe(42);
  });

  test('a recording still in progress enqueues nothing', async () => {
    const res = await post({ ...base, RecordingStatus: 'in-progress' });
    expect(res.status).toBe(204);
    expect(t.jobs.sent.filter((j) => j.name === 'fd-recording-store')).toHaveLength(0);
  });

  test('an unknown CallSid answers 204 without a job', async () => {
    const res = await post({ ...base, CallSid: 'CA_unknown', RecordingStatus: 'completed' });
    expect(res.status).toBe(204);
    expect(t.jobs.sent.filter((j) => j.name === 'fd-recording-store')).toHaveLength(0);
  });

  test('a callback without the company parameter answers 404', async () => {
    const res = await post({ ...base, RecordingStatus: 'completed' }, null, PATH_BASE);
    expect(res.status).toBe(404);
    expect(t.jobs.sent.filter((j) => j.name === 'fd-recording-store')).toHaveLength(0);
  });

  test('a missing RecordingSid is a 400', async () => {
    const res = await post({ CallSid: CALL_SID, RecordingStatus: 'completed' });
    expect(res.status).toBe(400);
  });

  test('a bad signature is rejected', async () => {
    const res = await post({ ...base, RecordingStatus: 'completed' }, 'bad-signature');
    expect(res.status).toBe(403);
    expect(t.jobs.sent.filter((j) => j.name === 'fd-recording-store')).toHaveLength(0);
  });
});
