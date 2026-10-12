import { eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { calls, companyPhoneNumbers, encrypt, textingRegistrations, withTenant, type TenantContext } from '@roofline/db';
import { storeRecording } from '../../src/jobs/recording-store.ts';
import { UnconfiguredObjectStore } from '../../src/providers/object-store.ts';
import { TwilioApiError } from '../../src/providers/twilio/http.ts';
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
const keyFor = (callId: string) => `recordings/${companyId()}/${callId}-${RECORDING_SID}.mp3`;

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

  test('the object key carries the recording sid', async () => {
    await run();
    expect((await callRow()).recordingKey).toBe(`recordings/${companyId()}/${callId}-${RECORDING_SID}.mp3`);
  });

  test('a failed delete at Twilio fails the job, and the retry deletes it without copying again', async () => {
    const del = vi.spyOn(t.callControl, 'deleteRecording').mockRejectedValueOnce(new Error('twilio 503'));
    await expect(run(1)).rejects.toThrow();
    expect((await callRow()).recordingStatus).toBe('stored');
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(true);
    del.mockRestore();
    await run(2);
    expect(puts()).toHaveLength(1);
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(false);
  });

  test('a recording Twilio no longer has (404) counts as deleted', async () => {
    vi.spyOn(t.callControl, 'deleteRecording').mockRejectedValueOnce(new TwilioApiError(404, 20404));
    await expect(run(1)).resolves.toBeUndefined();
    expect((await callRow()).recordingStatus).toBe('stored');
  });

  test('on the last attempt a failed delete is logged, not thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(t.callControl, 'deleteRecording').mockRejectedValueOnce(new Error('twilio 503'));
    await expect(run(5)).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain(`call=${callId}`);
  });

  test('a second recording on a call already stored is copied, not only deleted', async () => {
    await run();
    const second = 'RE00000000000000000000000000000002';
    const secondBytes = Uint8Array.from([0x49, 0x44, 0x33, 0x05]);
    t.callControl.putRecording(second, secondBytes);
    await storeRecording(t.deps, { companyId: companyId(), callId, recordingSid: second }, { attempt: 1, lastAttempt: false });
    const secondKey = `recordings/${companyId()}/${callId}-${second}.mp3`;
    expect(puts()).toHaveLength(2);
    expect(await t.objectStore.get(secondKey)).toEqual(secondBytes);
    expect((await callRow()).recordingKey).toBe(secondKey);
    expect(t.callControl.recordings.has(second)).toBe(false);
  });

  test('without file storage the Twilio copy is deleted and only metadata stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(1, { ...t.deps, objectStore: new UnconfiguredObjectStore() });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain(callId);
    expect(String(warn.mock.calls[0]![0])).toContain('recording deleted at Twilio, file storage not set up');
    expect(deletes()).toHaveLength(1);
    expect(puts()).toHaveLength(0);
    const row = await callRow();
    expect(row.recordingStatus).toBe('deleted');
    expect(row.recordingKey).toBeNull();
  });

  test('on the last attempt a failing copy still deletes the Twilio copy and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.callControl.failNext(1); // the fetch fails; the delete after it succeeds
    await expect(run(5)).resolves.toBeUndefined();
    expect(deletes()).toHaveLength(1);
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(false);
    const row = await callRow();
    expect(row.recordingStatus).toBe('deleted');
    expect(row.recordingKey).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(`recording store gave up, Twilio copy deleted call=${callId} company=${companyId()}`);
  });

  test('without file storage a caller who objected keeps stopped_by_caller', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withTenant(t.deps.pools, ctx(), (tx) => tx.update(calls).set({ recordingStatus: 'stopped_by_caller' }).where(eq(calls.id, callId)));
    await run(1, { ...t.deps, objectStore: new UnconfiguredObjectStore() });
    expect(deletes()).toHaveLength(1);
    expect(puts()).toHaveLength(0);
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(false);
    expect((await callRow()).recordingStatus).toBe('stopped_by_caller');
    expect((await callRow()).recordingKey).toBeNull();
  });

  test('on the last attempt a caller who objected keeps stopped_by_caller', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withTenant(t.deps.pools, ctx(), (tx) => tx.update(calls).set({ recordingStatus: 'stopped_by_caller' }).where(eq(calls.id, callId)));
    t.callControl.failNext(1);
    await expect(run(5)).resolves.toBeUndefined();
    expect(deletes()).toHaveLength(1);
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(false);
    expect((await callRow()).recordingStatus).toBe('stopped_by_caller');
    expect((await callRow()).recordingKey).toBeNull();
  });

  test('on an earlier attempt a failing copy throws and deletes nothing at Twilio', async () => {
    t.callControl.failNext(1);
    await expect(run(4)).rejects.toThrow();
    expect(deletes()).toHaveLength(0);
    expect(t.callControl.recordings.has(RECORDING_SID)).toBe(true);
    expect((await callRow()).recordingStatus).toBe('recording');
  });

  test('on the last attempt an upload that fails after writing leaves no orphan object', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realPut = t.objectStore.put.bind(t.objectStore);
    vi.spyOn(t.objectStore, 'put').mockImplementation(async (key, bytes, contentType) => {
      await realPut(key, bytes, contentType);
      throw new Error('Upload failed after writing');
    });
    await expect(run(5)).resolves.toBeUndefined();
    expect(await t.objectStore.get(keyFor(callId))).toBeNull();
    expect(deletes().map((c) => c.args[1])).toEqual([RECORDING_SID]);
    const row = await callRow();
    expect(row.recordingStatus).toBe('deleted');
    expect(row.recordingKey).toBeNull();
  });

  test('on an earlier attempt an upload that fails after writing throws and does not delete at Twilio', async () => {
    const realPut = t.objectStore.put.bind(t.objectStore);
    vi.spyOn(t.objectStore, 'put').mockImplementation(async (key, bytes, contentType) => {
      await realPut(key, bytes, contentType);
      throw new Error('Upload failed after writing');
    });
    await expect(run(4)).rejects.toThrow();
    expect(deletes()).toHaveLength(0);
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
    const res = await post({ ...base, CallSid: 'CA' + 'f'.repeat(32), RecordingStatus: 'completed' });
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
