import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import twilio from 'twilio';
import WebSocket from 'ws';
import { calls, findCallBySid, insertCall, setCallRecording, updateCall, withTenant } from '@roofline/db';
import { signingTokenFor } from '@roofline/db/system';
import { attachRelayUpgrade, RELAY_MAX_PAYLOAD, RELAY_MAX_QUEUED, RELAY_MAX_UNAUTH } from '../../src/front-desk/relay-server.ts';
import { mintRelayToken } from '../../src/front-desk/relay-token.ts';
import { type Script, ScriptedLlm } from '../../src/providers/fakes/scripted-llm.ts';
import type { RouteDecision } from '../../src/providers/llm.ts';
import { makeTestApp } from '../helpers.ts';

const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };
const SAY: Script = [{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'We can help with that.' }] }];
const TRANSFER: Script = [
  { when: /./, route: OPUS, answer: [{ kind: 'tool', name: 'transfer_to_person', input: { reason: 'asked', summary: 'x' } }] },
];
const CALLER_PHONE = '+15555550123';
const CALL_SID = `CA${'c'.repeat(32)}`;
const CALLER_TEXT = 'my roof has a purple dragon problem';

type Frame = Record<string, unknown>;
type Client = {
  ws: WebSocket;
  frames: Frame[];
  closed: Promise<number>;
  send(m: Frame): void;
  waitFor(pred: (f: Frame) => boolean, ms?: number): Promise<Frame>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const until = async (fn: () => Promise<boolean> | boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

async function rig(script: Script = SAY, opts: { idleMs?: number } = {}) {
  const t = await makeTestApp();
  const llm = new ScriptedLlm(script);
  const deps = { ...t.deps, llm, config: { ...t.deps.config, TWILIO_AUTH_TOKEN: 'relay-test-master-token' } };
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const handle = attachRelayUpgrade(server, deps, opts);
  cleanups.push(async () => {
    handle.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const port = (server.address() as AddressInfo).port;
  const ctx = { companyId: t.seed.a.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
  const row = await withTenant(t.deps.pools, ctx, (tx) =>
    insertCall(tx, ctx, { callSid: CALL_SID, fromE164: CALLER_PHONE, toE164: '+14025550100', forwardedFrom: null, stirVerstat: null, now: t.clock.now() }),
  );
  const token = mintRelayToken(deps.config.RELAY_TOKEN_SECRET, { callId: row.id, companyId: row.companyId }, t.clock.now());

  const signer = (await signingTokenFor(deps.pools.system, row.companyId, deps.config.TWILIO_AUTH_TOKEN, deps.config.ENCRYPTION_KEY)) as string;
  const sign = (tok: string, callId: string = row.id): string => twilio.getExpectedTwilioSignature(signer, `${deps.config.RELAY_PUBLIC_URL}?t=${tok}&c=${callId}`, {});
  /** A raw upgrade request; resolves with the HTTP status (101 when it upgraded). */
  const rawUpgrade = (tok: string, headers: Record<string, string> = {}, callId: string = row.id): Promise<number> =>
    new Promise((res) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: `/relay?t=${tok}&c=${callId}`,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
      });
      req.on('response', (resp) => { resp.resume(); res(resp.statusCode ?? 0); });
      req.on('upgrade', (_resp, sock) => { sock.destroy(); res(101); });
      req.on('error', () => res(0));
      req.end();
    });

  function connect(tok: string): Client {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay?t=${tok}&c=${row.id}`, { headers: { 'X-Twilio-Signature': sign(tok) } });
    const frames: Frame[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as Frame));
    ws.on('error', () => undefined);
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    cleanups.push(() => ws.terminate());
    return {
      ws,
      frames,
      closed,
      send: (m) => ws.send(JSON.stringify(m)),
      async waitFor(pred, ms = 5000) {
        let found: Frame | undefined;
        await until(() => {
          found = frames.find(pred);
          return found !== undefined;
        }, ms);
        return found as Frame;
      },
    };
  }
  const setupMsg = (callId = row.id): Frame => ({ type: 'setup', callSid: CALL_SID, from: CALLER_PHONE, to: '+14025550100', customParameters: { callId } });
  const open = async (tok = token, callId = row.id): Promise<Client> => {
    const c = connect(tok);
    await new Promise<void>((r) => c.ws.once('open', () => r()));
    c.send(setupMsg(callId));
    return c;
  };
  const readCall = () => withTenant(t.deps.pools, ctx, async (tx) => {
    const found = await findCallBySid(tx, ctx, CALL_SID);
    const [s] = await tx.select({ s: calls.aiSeconds }).from(calls);
    return { status: found?.status, aiSeconds: s?.s ?? -1 };
  });
  const setStatus = (status: 'ended' | 'failed' | 'rejected' | 'ringing_team' | 'transferred') =>
    withTenant(t.deps.pools, ctx, (tx) => updateCall(tx, ctx, CALL_SID, { status }));
  const readTranscriptStored = () =>
    withTenant(t.deps.pools, ctx, async (tx) => {
      const [s] = await tx.select({ v: calls.transcriptStored }).from(calls);
      return s?.v;
    });
  const stopRecording = () => withTenant(t.deps.pools, ctx, (tx) => setCallRecording(tx, ctx, CALL_SID, { recordingStatus: 'stopped_by_caller' }));
  return { t, deps, row, token, port, rawUpgrade, sign, readTranscriptStored, stopRecording, setStatus, connect, open, setupMsg, readCall, llm };
}

const isEnd = (f: Frame): boolean => f.type === 'end';

describe('relay websocket server', () => {
  test('an unsigned upgrade gets 401 with no socket', async () => {
    const r = await rig();
    expect(await r.rawUpgrade(r.token)).toBe(401);
    expect(r.deps.relaySessions.size).toBe(0);
    expect(await r.rawUpgrade(r.token, { 'X-Twilio-Signature': r.sign(r.token) })).toBe(101);
  });

  test('a bad token gets 401', async () => {
    const r = await rig();
    expect(await r.rawUpgrade('nonsense', { 'X-Twilio-Signature': r.sign('nonsense') })).toBe(401);
    expect(r.deps.relaySessions.size).toBe(0);
  });

  test('a wrong signature gets 401 with no socket', async () => {
    const r = await rig();
    expect(await r.rawUpgrade(r.token, { 'X-Twilio-Signature': 'AAAA' })).toBe(401);
    expect(r.deps.relaySessions.has(CALL_SID)).toBe(false);
  });

  test('a well-shaped forged token with a correct signature gets 401', async () => {
    const r = await rig();
    const forged = `${Date.now() + 60000}.${'a'.repeat(64)}`;
    expect(await r.rawUpgrade(forged, { 'X-Twilio-Signature': r.sign(forged) })).toBe(401);
    expect(r.deps.relaySessions.has(CALL_SID)).toBe(false);
  });

  test('a valid token and signature for a call id with no call gets 401', async () => {
    const r = await rig();
    const ghost = '11111111-2222-4333-8444-555555555555';
    expect(await r.rawUpgrade(r.token, { 'X-Twilio-Signature': r.sign(r.token, ghost) }, ghost)).toBe(401);
    expect(r.deps.relaySessions.has(CALL_SID)).toBe(false);
  });

  test('a valid token and signature for an ended call gets 401 at the upgrade', async () => {
    const r = await rig();
    await r.setStatus('ended');
    expect(await r.rawUpgrade(r.token, { 'X-Twilio-Signature': r.sign(r.token) })).toBe(401);
    expect(r.deps.relaySessions.has(CALL_SID)).toBe(false);
  });

  test('60 bad-signature upgrades in a row each get 401 and a valid connect still opens', async () => {
    const r = await rig();
    for (let i = 0; i < 60; i += 1) expect(await r.rawUpgrade(r.token, { 'X-Twilio-Signature': 'AAAA' })).toBe(401);
    expect(r.deps.relaySessions.has(CALL_SID)).toBe(false);
    const ok = await r.open();
    await until(() => r.deps.relaySessions.size === 1);
    ok.ws.close();
    await ok.closed;
  });

  test('a bad token (right shape, wrong MAC) is denied after setup', async () => {
    const r = await rig();
    const flipped = r.token.slice(0, -1) + (r.token.endsWith('0') ? '1' : '0');
    const c2 = await r.open(flipped);
    expect(await c2.closed).toBe(1006);
  });

  test('an expired token is refused at the upgrade', async () => {
    const r = await rig();
    r.t.clock.advance(11 * 60 * 1000);
    expect(await r.rawUpgrade(r.token, { 'X-Twilio-Signature': r.sign(r.token) })).toBe(401);
  });

  test('60 denied sockets in a row do not block the 61st valid one', async () => {
    const r = await rig();
    for (let i = 0; i < RELAY_MAX_UNAUTH + 10; i += 1) {
      const c = await r.open(r.token, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      await c.closed;
    }
    const ok = await r.open();
    await until(() => r.deps.relaySessions.size === 1);
    ok.ws.close();
    await ok.closed;
  });

  test('after setup the call reads transcript_stored true, and false after an objection', async () => {
    const r = await rig(SAY);
    const c = await r.open();
    await until(async () => (await r.readTranscriptStored()) === true);
    c.send({ type: 'prompt', voicePrompt: "please don't record me", last: true });
    await c.waitFor((f) => f.type === 'text' && f.last === true);
    await until(async () => (await r.readTranscriptStored()) === false);
    c.ws.close();
    await c.closed;
  });

  test('a second session on a stopped_by_caller call keeps transcript_stored false', async () => {
    const r = await rig(SAY);
    await r.stopRecording();
    const c = await r.open();
    await until(() => r.deps.relaySessions.size === 1);
    expect(await r.readTranscriptStored()).toBe(false);
    c.ws.close();
    await c.closed;
  });

  test('company A token with company B call is denied (1006)', async () => {
    const r = await rig();
    const ctxB = { companyId: r.t.seed.b.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
    const rowB = await withTenant(r.t.deps.pools, ctxB, (tx) =>
      insertCall(tx, ctxB, { callSid: `CA${'d'.repeat(32)}`, fromE164: CALLER_PHONE, toE164: '+14025550101', forwardedFrom: null, stirVerstat: null, now: r.t.clock.now() }),
    );
    const c = await r.open(r.token, rowB.id);
    expect(await c.closed).toBe(1006);
  });

  test('a second socket for the same call is denied (1006)', async () => {
    const r = await rig();
    const first = await r.open();
    await until(() => r.deps.relaySessions.size === 1);
    const second = await r.open();
    expect(await second.closed).toBe(1006);
    expect(r.deps.relaySessions.size).toBe(1);
    first.ws.close();
    await first.closed;
  });

  test('a full scripted call: setup, prompt, text tokens, end with handoff', async () => {
    const r = await rig(TRANSFER);
    const c = await r.open();
    c.send({ type: 'prompt', voicePrompt: 'let me talk to a person', last: true });
    const end = await c.waitFor(isEnd);
    expect(JSON.parse(end.handoffData as string)).toMatchObject({ kind: 'transfer' });
    c.ws.close();
    await c.closed;
  });

  test('a full scripted call streams text tokens', async () => {
    const r = await rig(SAY);
    const c = await r.open();
    c.send({ type: 'prompt', voicePrompt: 'hello', last: true });
    await c.waitFor((f) => f.type === 'text' && f.last === true);
    expect(c.frames.some((f) => f.type === 'text' && String(f.token).includes('We can help'))).toBe(true);
    c.ws.close();
    await c.closed;
  });

  test('an interrupt message truncates and cancels the turn', async () => {
    const r = await rig(SAY);
    r.llm.delayMs = 400;
    const c = await r.open();
    c.send({ type: 'prompt', voicePrompt: 'hello', last: true });
    await new Promise((res) => setTimeout(res, 50));
    c.send({ type: 'interrupt', utteranceUntilInterrupt: 'We can', durationUntilInterruptMs: 300 });
    await new Promise((res) => setTimeout(res, 800));
    expect(c.frames.some((f) => f.type === 'text' && String(f.token).includes('We can help'))).toBe(false);
    c.ws.close();
    await c.closed;
  });

  test('idle: 20 s of silence prompts Are you still there and 20 s more ends', async () => {
    const r = await rig(SAY, { idleMs: 50 });
    const c = await r.open();
    const prompt = await c.waitFor((f) => f.type === 'text' && f.token === 'Are you still there?');
    expect(prompt.last).toBe(true);
    const end = await c.waitFor(isEnd);
    expect(JSON.parse(end.handoffData as string)).toEqual({ kind: 'end', reason: 'silence' });
    c.ws.close();
    await c.closed;
  });

  test('ai_seconds is measured from the clock between open and close', async () => {
    const r = await rig();
    const c = await r.open();
    await until(async () => (await r.readCall()).status === 'ai');
    r.t.clock.advance(90_000);
    c.ws.close();
    await c.closed;
    await until(async () => (await r.readCall()).aiSeconds === 90);
  });

  test('the registry decrements on close', async () => {
    const r = await rig();
    const c = await r.open();
    await until(() => r.deps.relaySessions.size === 1);
    c.ws.close();
    await c.closed;
    await until(() => r.deps.relaySessions.size === 0);
  });

  test('a socket dropped mid-authentication leaves no registry entry', async () => {
    const r = await rig();
    const c = r.connect(r.token);
    const add = r.deps.relaySessions.add.bind(r.deps.relaySessions);
    vi.spyOn(r.deps.relaySessions, 'add').mockImplementation((sid) => {
      add(sid);
      c.ws.terminate();
    });
    await new Promise<void>((res) => c.ws.once('open', () => res()));
    c.send(r.setupMsg());
    await c.closed;
    await until(() => r.deps.relaySessions.size === 0);
    await new Promise((res) => setTimeout(res, 300));
    expect(r.deps.relaySessions.size).toBe(0);
  });

  test('no transcript text, phone or token in logs', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const r = await rig(SAY);
    const c = await r.open();
    c.send({ type: 'prompt', voicePrompt: CALLER_TEXT, last: true });
    await c.waitFor((f) => f.type === 'text' && f.last === true);
    c.send({ type: 'error', description: `${CALLER_TEXT} ${CALLER_PHONE}` });
    c.ws.close();
    await c.closed;
    await until(() => r.deps.relaySessions.size === 0);
    await new Promise((res) => setTimeout(res, 100));
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(CALLER_TEXT);
    expect(logged).not.toContain('+1555');
    expect(logged).not.toContain(r.token);
  });

  test('an oversized frame closes the socket', async () => {
    const r = await rig();
    const c = r.connect(r.token);
    await new Promise<void>((res) => c.ws.once('open', () => res()));
    c.ws.send('x'.repeat(RELAY_MAX_PAYLOAD + 1));
    expect(await c.closed).toBe(1009);
  });

  test('a flood of frames before setup completes is denied (1006)', async () => {
    const r = await rig();
    const c = r.connect(r.token);
    await new Promise<void>((res) => c.ws.once('open', () => res()));
    c.send(r.setupMsg());
    for (let i = 0; i < RELAY_MAX_QUEUED + 300; i += 1) c.send({ type: 'prompt', voicePrompt: 'hi', last: false });
    expect(await c.closed).toBe(1006);
  });

  test('the pre-auth cap refuses extra upgrades with 503', async () => {
    const r = await rig();
    const idle: WebSocket[] = [];
    for (let i = 0; i < RELAY_MAX_UNAUTH; i += 1) {
      const c = r.connect(r.token);
      idle.push(c.ws);
    }
    await Promise.all(idle.map((w) => new Promise<void>((res) => w.once('open', () => res()))));
    const extra = new WebSocket(`ws://127.0.0.1:${r.port}/relay?t=${r.token}&c=${r.row.id}`);
    extra.on('error', () => undefined);
    cleanups.push(() => extra.terminate());
    const status = await new Promise<number>((res) => {
      extra.once('unexpected-response', (_req, resp) => res(resp.statusCode ?? 0));
      extra.once('open', () => res(0));
    });
    expect(status).toBe(503);
    for (const w of idle) w.terminate();
  });

  test('aborted handshakes do not use up pre-auth slots', async () => {
    const r = await rig();
    for (let i = 0; i < RELAY_MAX_UNAUTH + 5; i += 1) {
      await new Promise<void>((res) => {
        const req = request({
          host: '127.0.0.1',
          port: r.port,
          path: `/relay?t=${r.token}&c=${r.row.id}`,
          headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'bad' },
        });
        req.on('response', (resp) => { resp.resume(); res(); });
        req.on('upgrade', (_resp, sock) => { sock.destroy(); res(); });
        req.on('error', () => res());
        req.on('close', () => res());
        req.end();
      });
    }
    const c = r.connect(r.token);
    const opened = await new Promise<boolean>((res) => {
      c.ws.once('open', () => res(true));
      c.ws.once('unexpected-response', () => res(false));
    });
    expect(opened).toBe(true);
  });

  test.each(['ended', 'failed', 'rejected'] as const)('a token for a %s call is refused', async (status) => {
    const r = await rig();
    await r.setStatus(status);
    expect(await r.rawUpgrade(r.token, { 'X-Twilio-Signature': r.sign(r.token) })).toBe(401);
    expect((await r.readCall()).status).toBe(status);
    expect(r.deps.relaySessions.size).toBe(0);
  });

  test.each(['ringing_team', 'transferred'] as const)('a message_only reconnect works for a call in status %s', async (status) => {
    const r = await rig();
    await r.setStatus(status);
    const c = r.connect(r.token);
    await new Promise<void>((res) => c.ws.once('open', () => res()));
    c.send({ ...r.setupMsg(), customParameters: { callId: r.row.id, mode: 'message_only' } });
    await until(() => r.deps.relaySessions.size === 1);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
    await c.closed;
  });
});
