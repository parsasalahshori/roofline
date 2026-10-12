import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { calls, findCallBySid, insertCall, withTenant } from '@roofline/db';
import { attachRelayUpgrade } from '../../src/front-desk/relay-server.ts';
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
  const deps = { ...t.deps, llm };
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

  function connect(tok: string): Client {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay?t=${tok}`);
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
  return { t, deps, row, token, connect, open, setupMsg, readCall, llm };
}

const isEnd = (f: Frame): boolean => f.type === 'end';

describe('relay websocket server', () => {
  test('a bad token closes 1008', async () => {
    const r = await rig();
    const c = r.connect('nonsense');
    expect(await c.closed).toBe(1008);
    const c2 = await r.open(`${Date.now() + 100000}.${'0'.repeat(64)}`);
    expect(await c2.closed).toBe(1008);
  });

  test('an expired token closes 1008', async () => {
    const r = await rig();
    r.t.clock.advance(11 * 60 * 1000);
    const c = r.connect(r.token);
    expect(await c.closed).toBe(1008);
  });

  test('company A token with company B call closes 1008', async () => {
    const r = await rig();
    const ctxB = { companyId: r.t.seed.b.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
    const rowB = await withTenant(r.t.deps.pools, ctxB, (tx) =>
      insertCall(tx, ctxB, { callSid: `CA${'d'.repeat(32)}`, fromE164: CALLER_PHONE, toE164: '+14025550101', forwardedFrom: null, stirVerstat: null, now: r.t.clock.now() }),
    );
    const c = await r.open(r.token, rowB.id);
    expect(await c.closed).toBe(1008);
  });

  test('a second socket for the same call closes 1008', async () => {
    const r = await rig();
    const first = await r.open();
    await until(() => r.deps.relaySessions.size === 1);
    const second = await r.open();
    expect(await second.closed).toBe(1008);
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
});
