import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import twilio from 'twilio';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { addAiSeconds, findCallBySid, updateCall, withTenant, type TenantContext } from '@roofline/db';
import { relayCallById, signingTokenFor } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import type { RelayIn, RelayOut, VoiceSession } from '../providers/voice-session.ts';
import { createEngine } from './engine.ts';
import type { ToolHandlers } from './engine-types.ts';
import { runRelayLoop } from './relay-session-loop.ts';
import { verifyRelayToken } from './relay-token.ts';

export const RELAY_PATH = '/relay';
export const RELAY_CLOSE_POLICY = 1008;
const REFUSED = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
const SETUP_WITHIN_MS = 5000;
const DEFAULT_IDLE_MS = 20_000;
const TOKEN_SHAPE = /^(\d+)\.[0-9a-f]{64}$/;
const REASON_AUTH = 'Not allowed.';
const REASON_SETUP = 'Setup expected.';
const IDLE_PROMPT = 'Are you still there?';

type Opts = { tools?: ToolHandlers; idleMs?: number };

function parseFrame(data: RawData): RelayIn | null {
  try {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || typeof (v as { type?: unknown }).type !== 'string') return null;
    return v as RelayIn;
  } catch {
    return null;
  }
}

/**
 * Attaches the ConversationRelay WebSocket upgrade to the HTTP server. Only /relay upgrades; any
 * other upgrade path is refused. The `?t=` token is checked for shape and expiry at the upgrade and
 * fully (call and company) on the first `setup` message, which names the call. Logs carry the call
 * id and company id only.
 */
export function attachRelayUpgrade(server: Server, deps: AppDeps, opts: Opts = {}): { close(): void } {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const engine = createEngine(deps, opts.tools ?? {});
  const wss = new WebSocketServer({ noServer: true });
  const live = new Set<WebSocket>();

  function onConnection(ws: WebSocket, req: IncomingMessage, token: string | null): void {
    live.add(ws);
    ws.on('close', () => live.delete(ws));
    ws.on('error', () => undefined);
    const deny = (reason: string): void => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(RELAY_CLOSE_POLICY, reason);
    };
    if (token === null) {
      deny(REASON_AUTH);
      return;
    }

    type Stage = 'waiting' | 'authenticating' | 'running' | 'dead';
    let stage: Stage = 'waiting';
    const queued: RelayIn[] = [];
    let handler: ((m: RelayIn) => void) | null = null;
    const closeHandlers: (() => void)[] = [];
    let closedOnce = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let idleStage = 0;
    let identity: { callId: string; companyId: string; callSid: string } | null = null;
    let startedAt: Date | null = null;
    let loop: ReturnType<typeof runRelayLoop> | null = null;

    const setupTimer = setTimeout(() => {
      if (stage === 'waiting') deny(REASON_SETUP);
    }, SETUP_WITHIN_MS);

    const rawSend = (m: RelayOut): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };

    function clearIdle(): void {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    }
    function armIdle(): void {
      clearIdle();
      if (stage !== 'running') return;
      idleTimer = setTimeout(() => {
        if (idleStage === 0) {
          idleStage = 1;
          rawSend({ type: 'text', token: IDLE_PROMPT, last: true });
          armIdle();
        } else {
          idleStage = 2;
          rawSend({ type: 'end', handoffData: JSON.stringify({ kind: 'end', reason: 'silence' }) });
        }
      }, idleMs);
    }
    function activity(): void {
      idleStage = 0;
      armIdle();
    }

    const adapter: VoiceSession = {
      onMessage(h) {
        handler = h;
      },
      send(m) {
        if (m.type === 'text' && m.token !== '') activity();
        rawSend(m);
      },
      close() {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      },
      onClose(h) {
        closeHandlers.push(h);
      },
    };

    const deliver = (m: RelayIn): void => {
      if (m.type !== 'setup') activity();
      handler?.(m);
    };

    async function authenticate(setup: Extract<RelayIn, { type: 'setup' }>): Promise<void> {
      const callId = setup.customParameters?.callId;
      if (typeof callId !== 'string') return deny(REASON_AUTH);
      const row = await relayCallById(deps.pools.system, callId);
      if (row === null || !verifyRelayToken(deps.config.RELAY_TOKEN_SECRET, token as string, { callId, companyId: row.companyId }, deps.clock.now())) {
        return deny(REASON_AUTH);
      }
      const signature = req.headers['x-twilio-signature'];
      if (signature !== undefined) {
        const signer = await signingTokenFor(deps.pools.system, row.companyId, deps.config.TWILIO_AUTH_TOKEN, deps.config.ENCRYPTION_KEY);
        const search = new URL(req.url ?? '/', 'http://localhost').search;
        const sig = Array.isArray(signature) ? signature[0] : signature;
        if (signer === null || sig === undefined || !twilio.validateRequest(signer, sig, deps.config.RELAY_PUBLIC_URL + search, {})) {
          return deny(REASON_AUTH);
        }
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      // The check and the add are one synchronous step: no second socket can slip between them.
      if (deps.relaySessions.has(row.callSid)) return deny(REASON_AUTH);
      deps.relaySessions.add(row.callSid);
      identity = { callId: row.callId, companyId: row.companyId, callSid: row.callSid };
      const ctx: TenantContext = { companyId: row.companyId, userId: null, role: 'system', canApproveSpend: false };
      try {
        startedAt = deps.clock.now();
        const call = await withTenant(deps.pools, ctx, async (tx) => {
          const found = await findCallBySid(tx, ctx, row.callSid);
          if (found === null) return null;
          await updateCall(tx, ctx, row.callSid, { status: 'ai', aiStartedAt: startedAt as Date });
          return found;
        });
        if (call === null) return deny(REASON_AUTH);
        // The socket may have closed while withTenant ran; the close handler already removed the registry entry.
        if (stage === 'dead' || ws.readyState !== WebSocket.OPEN) return;
        stage = 'running';
        loop = runRelayLoop(adapter, {
          deps,
          engine,
          call: {
            callId: row.callId,
            companyId: row.companyId,
            callSid: row.callSid,
            from: call.fromE164,
            to: call.toE164,
            messageOnly: setup.customParameters?.mode === 'message_only',
          },
        });
        deliver(setup);
        for (const m of queued.splice(0)) deliver(m);
        armIdle();
      } catch {
        console.error(`relay setup failed call=${row.callId} company=${row.companyId}`);
        deny(REASON_AUTH);
      }
    }

    ws.on('message', (data) => {
      const m = parseFrame(data);
      if (m === null) return;
      if (stage === 'waiting') {
        if (m.type !== 'setup') return deny(REASON_SETUP);
        stage = 'authenticating';
        clearTimeout(setupTimer);
        authenticate(m).catch(() => {
          console.error('relay auth failed');
          deny(REASON_AUTH);
        });
      } else if (stage === 'authenticating') {
        queued.push(m);
      } else if (stage === 'running') {
        deliver(m);
      }
    });

    ws.on('close', () => {
      if (closedOnce) return;
      closedOnce = true;
      stage = 'dead';
      clearTimeout(setupTimer);
      clearIdle();
      for (const h of closeHandlers) h();
      const id = identity;
      if (id === null) return;
      deps.relaySessions.remove(id.callSid);
      void (async () => {
        try {
          await loop?.settled();
          const seconds = Math.max(0, Math.round((deps.clock.now().getTime() - (startedAt ?? deps.clock.now()).getTime()) / 1000));
          const ctx: TenantContext = { companyId: id.companyId, userId: null, role: 'system', canApproveSpend: false };
          await withTenant(deps.pools, ctx, (tx) => addAiSeconds(tx, ctx, id.callSid, seconds));
          await deps.jobs.send('fd-after-call', { companyId: id.companyId, callSid: id.callSid }, { singletonKey: `fd-after-call:${id.callSid}`, startAfter: 5 });
        } catch {
          console.error(`relay close failed call=${id.callId} company=${id.companyId}`);
        }
      })();
    });
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== RELAY_PATH) {
      socket.write(REFUSED);
      socket.destroy();
      return;
    }
    const t = url.searchParams.get('t');
    const m = t === null ? null : TOKEN_SHAPE.exec(t);
    const token = m !== null && Number(m[1]) > deps.clock.now().getTime() ? t : null;
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, token));
  };
  server.on('upgrade', onUpgrade);
  return {
    close() {
      server.off('upgrade', onUpgrade);
      for (const ws of live) ws.close(1001);
      wss.close();
    },
  };
}
