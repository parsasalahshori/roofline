import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { calls, conversations, customers, withTenant, type TenantContext } from '@roofline/db';
import { MemoryObjectStore } from '../../src/providers/fakes/object-store.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from '../helpers.ts';

/*
 * Task 12: GET /api/calls/:id/recording. Database-backed (CI runs it), except the
 * MemoryObjectStore unit tests at the bottom.
 */

const ROLE_MESSAGE = "Your role can't do that. Ask the owner.";
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
  const key = `recordings/${idOf('a')}/${callId}.mp3`;
  if (recordingStatus !== 'none') {
    await withTenant(t.deps.pools, ctxOf('a'), async (tx) => {
      await tx.update(calls).set({ recordingKey: key }).where(eq(calls.id, callId));
    });
    await t.objectStore.put(key, new Uint8Array([1, 2, 3]), 'audio/mpeg');
  }
  return { callId, key };
}

describe('GET /api/calls/:id/recording', () => {
  beforeEach(async () => {
    t = await makeTestApp();
    t.clock.set(new Date());
  });

  test.each(['owner', 'office'] as const)('%s gets a 302 to a signed url', async (role) => {
    const { callId, key } = await seedCall();
    const res = await (await agentFor(role)).get(`/api/calls/${callId}/recording`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location.startsWith(`memory://${key}?expires=`)).toBe(true);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(t.objectStore.calls).toContainEqual({ method: 'signedGetUrl', key, seconds: 300 });
  });

  test('a stopped_by_caller recording with a key is playable', async () => {
    const { callId } = await seedCall({ status: 'stopped_by_caller' });
    const res = await (await agentFor('owner')).get(`/api/calls/${callId}/recording`).redirects(0);
    expect(res.status).toBe(302);
  });

  test('Accept: application/json answers url and expiresAt, 300 seconds after the app clock', async () => {
    const { callId, key } = await seedCall();
    const now = new Date('2026-10-12T12:00:00.000Z');
    t.clock.set(now);
    const res = await (await agentFor('owner')).get(`/api/calls/${callId}/recording`).set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.url.startsWith(`memory://${key}?expires=`)).toBe(true);
    expect(res.body.expiresAt).toBe(new Date(now.getTime() + 300_000).toISOString());
  });

  test("a rep plays a call of a customer they created but not another rep's customer", async () => {
    const mine = await seedCall({ createdBy: t.seed.a.rep.userId });
    const theirs = await seedCall({ createdBy: t.seed.a.owner.userId });
    const rep = await agentFor('rep');
    expect((await rep.get(`/api/calls/${mine.callId}/recording`).redirects(0)).status).toBe(302);
    const denied = await rep.get(`/api/calls/${theirs.callId}/recording`).redirects(0);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: ROLE_MESSAGE });
  });

  test('a rep cannot play a transferred leg even for their own customer', async () => {
    const { callId } = await seedCall({ createdBy: t.seed.a.rep.userId, transferResult: 'answered' });
    const res = await (await agentFor('rep')).get(`/api/calls/${callId}/recording`).redirects(0);
    expect(res.status).toBe(403);
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
