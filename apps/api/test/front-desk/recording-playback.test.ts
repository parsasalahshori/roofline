import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Response } from 'superagent';
import { beforeEach, describe, expect, test } from 'vitest';
import { calls, conversations, customers, withTenant, type TenantContext } from '@roofline/db';
import { MemoryObjectStore } from '../../src/providers/fakes/object-store.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from '../helpers.ts';

/*
 * Task 12: GET /api/calls/:id/recording. Database-backed (CI runs it), except the
 * MemoryObjectStore unit tests at the bottom.
 */

const NOT_FOUND = "We couldn't find that.";
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

let t: TestApp;
let sidCounter = 0;
const idOf = (c: 'a' | 'b') => t.seed[c].companyId;
const ctxOf = (c: 'a' | 'b'): TenantContext => ({ companyId: idOf(c), role: 'system', userId: null, canApproveSpend: false });
const agentFor = (user: 'owner' | 'office' | 'rep', company: 'a' | 'b' = 'a'): Promise<SuperAgent> => loginAs(t.app, t.seed[company][user]);

type SeedOpts = { createdBy?: string | null; status?: 'stored' | 'none' | 'stopped_by_caller'; transferResult?: 'answered' | 'no_answer' | null };

/** A call of company A with a customer created by `createdBy`, its recording key stored in the fake bucket. */
async function seedCall(opts: SeedOpts = {}): Promise<{ callId: string; key: string }> {
  const recordingStatus = opts.status ?? 'stored';
  const callSid = `CR${String(++sidCounter).padStart(32, '0')}`;
  const callId = await withTenant(t.deps.pools, ctxOf('a'), async (tx) => {
    const [cust] = await tx
      .insert(customers)
      .values({ companyId: idOf('a'), displayName: 'Playback Customer', createdByUserId: opts.createdBy ?? null })
      .returning({ id: customers.id });
    const [conv] = await tx
      .insert(conversations)
      .values({ companyId: idOf('a'), channel: 'voice', phoneE164: '+14025550111', companyNumberE164: '+14025550200', status: 'ended', customerId: cust!.id })
      .returning({ id: conversations.id });
    const [call] = await tx
      .insert(calls)
      .values({
        companyId: idOf('a'),
        callSid,
        fromE164: '+14025550111',
        toE164: '+14025550200',
        status: 'ended',
        startedAt: new Date(),
        conversationId: conv!.id,
        recordingStatus,
        recordingKey: recordingStatus === 'none' ? null : 'placeholder',
        transferResult: opts.transferResult ?? null,
      })
      .returning({ id: calls.id });
    return call!.id;
  });
  const key = `recordings/${idOf('a')}/${callId}-RE${String(sidCounter).padStart(32, '0')}.mp3`;
  if (recordingStatus !== 'none') {
    await withTenant(t.deps.pools, ctxOf('a'), async (tx) => {
      await tx.update(calls).set({ recordingKey: key }).where(eq(calls.id, callId));
    });
    await t.objectStore.put(key, new Uint8Array([1, 2, 3]), 'audio/mpeg');
  }
  return { callId, key };
}

/** Collects a binary response body into a Buffer. */
const binary = (res: Response, cb: (err: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('GET /api/calls/:id/recording', () => {
  beforeEach(async () => {
    t = await makeTestApp();
    t.clock.set(new Date());
  });

  test.each(['owner', 'office'] as const)('%s gets the bytes as audio/mpeg, no-store', async (role) => {
    const { callId } = await seedCall();
    const res = await (await agentFor(role)).get(`/api/calls/${callId}/recording`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect([...(res.body as Buffer)]).toEqual([1, 2, 3]);
  });

  test('a Range request gets a 206 with the slice', async () => {
    const { callId } = await seedCall();
    const res = await (await agentFor('owner')).get(`/api/calls/${callId}/recording`).set('Range', 'bytes=1-2').buffer(true).parse(binary);
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 1-2/3');
    expect([...(res.body as Buffer)]).toEqual([2, 3]);
  });

  test('an unsatisfiable Range gets a 416', async () => {
    const { callId } = await seedCall();
    const res = await (await agentFor('owner')).get(`/api/calls/${callId}/recording`).set('Range', 'bytes=10-20');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */3');
  });

  test('a stopped_by_caller recording with a key is playable', async () => {
    const { callId } = await seedCall({ status: 'stopped_by_caller' });
    const res = await (await agentFor('owner')).get(`/api/calls/${callId}/recording`);
    expect(res.status).toBe(200);
  });

  test('the conversation detail carries no storage url', async () => {
    const { callId } = await seedCall();
    const owner = await agentFor('owner');
    const conv = await withTenant(t.deps.pools, ctxOf('a'), (tx) => tx.select({ id: calls.conversationId }).from(calls).where(eq(calls.id, callId)));
    const res = await owner.get(`/api/conversations/${conv[0]!.id}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('r2.cloudflarestorage.com');
    expect(JSON.stringify(res.body)).not.toContain('memory://');
  });

  test("a rep plays a call of a customer they created but not another rep's customer", async () => {
    const mine = await seedCall({ createdBy: t.seed.a.rep.userId });
    const theirs = await seedCall({ createdBy: t.seed.a.owner.userId });
    const rep = await agentFor('rep');
    expect((await rep.get(`/api/calls/${mine.callId}/recording`)).status).toBe(200);
    const denied = await rep.get(`/api/calls/${theirs.callId}/recording`);
    expect(denied.status).toBe(404);
    expect(denied.body).toEqual({ error: "We couldn't find that." });
  });

  test('a rep cannot play a transferred leg even for their own customer', async () => {
    const { callId } = await seedCall({ createdBy: t.seed.a.rep.userId, transferResult: 'answered' });
    const res = await (await agentFor('rep')).get(`/api/calls/${callId}/recording`);
    expect(res.status).toBe(404);
  });

  test('a call with no stored recording is 404', async () => {
    const { callId } = await seedCall({ status: 'none' });
    const res = await (await agentFor('owner')).get(`/api/calls/${callId}/recording`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });

  test("another company's call, an unknown id and a non-UUID id are 404", async () => {
    const { callId } = await seedCall();
    const b = await agentFor('owner', 'b');
    expect((await b.get(`/api/calls/${callId}/recording`)).status).toBe(404);
    const a = await agentFor('owner');
    expect((await a.get(`/api/calls/${ZERO_UUID}/recording`)).status).toBe(404);
    expect((await a.get('/api/calls/not-a-uuid/recording')).status).toBe(404);
  });

  test('unauthenticated is 401', async () => {
    const { callId } = await seedCall();
    expect((await request(t.app).get(`/api/calls/${callId}/recording`)).status).toBe(401);
  });
});

describe('Content-Security-Policy', () => {
  test('allows media from this origin only', async () => {
    t = await makeTestApp();
    const res = await request(t.app).get('/health');
    expect(res.headers['content-security-policy']).toContain("media-src 'self'");
  });
});

describe('MemoryObjectStore signed urls and delete', () => {
  test('signedGetUrl is deterministic in shape', async () => {
    const store = new MemoryObjectStore();
    const url = await store.signedGetUrl('recordings/x/y.mp3', 300);
    expect(url.startsWith('memory://recordings/x/y.mp3?expires=')).toBe(true);
  });

  test('delete removes the object, and a missing key does not throw', async () => {
    const store = new MemoryObjectStore();
    await store.put('recordings/x/y.mp3', new Uint8Array([1]), 'audio/mpeg');
    await store.delete('recordings/x/y.mp3');
    expect(await store.get('recordings/x/y.mp3')).toBeNull();
    await expect(store.delete('recordings/missing.mp3')).resolves.toBeUndefined();
  });
});
