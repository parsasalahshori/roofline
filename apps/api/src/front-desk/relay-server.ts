import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import twilio from 'twilio';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { eq } from 'drizzle-orm';
import {
  addAiSeconds,
  companySettings,
  findCallBySid,
  findCallRecordingBySid,
  setCallRecording,
  updateCall,
  withTenant,
  type TenantContext,
} from '@roofline/db';
import { relayCallById, signingTokenFor } from '@roofline/db/system';
import { UUID } from '../validate.ts';
import type { AppDeps } from '../app.ts';
import type { RelayIn, RelayOut, VoiceSession } from '../providers/voice-session.ts';
import { createEngine } from './engine.ts';
import { createRecording } from './recording.ts';
import type { ToolHandlers } from './engine-types.ts';
import { FRONT_DESK_HANDLERS } from './tools/index.ts';
import { runRelayLoop } from './relay-session-loop.ts';
import { verifyRelayToken } from './relay-token.ts';

export const RELAY_PATH = '/relay';
export const RELAY_CLOSE_POLICY = 1008;
export const RELAY_MAX_PAYLOAD = 64 * 1024;
export const RELAY_MAX_QUEUED = 32;
export const RELAY_MAX_UNAUTH = 50;
const UNAVAILABLE = 'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
const ENDED_STATUSES = new Set(['ended', 'failed', 'rejected']);
const REASON_FLOOD = 'Too many messages.';
const REFUSED = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
const UNAUTHORIZED = 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
const DEFAULT_RETENTION_DAYS = 90;
const SETUP_WITHIN_MS = 5000;
const DEFAULT_IDLE_MS = 20_000;
const REASON_AUTH = 'Not allowed.';
const REASON_SETUP = 'Setup expected.';
const IDLE_PROMPT = 'Are you still there?';

type RelayRow = NonNullable<Awaited<ReturnType<typeof relayCallById>>>;
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
 * other upgrade path is refused. The upgrade itself verifies the Twilio signature, the `?t=` token
 * (bound to the `?c=` call and its company) and that the call is live before it upgrades; the first
 * `setup` message must then name the same call. Logs carry the call id and company id only.
 */
export function attachRelayUpgrade(server: Server, deps: AppDeps, opts: Opts = {}): { close(): void } {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const engine = createEngine(deps, opts.tools ?? FRONT_DESK_HANDLERS);
  const wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_PAYLOAD });
  const live = new Set<WebSocket>();
  let unauth = 0;

  function onConnection(ws: WebSocket, verified: RelayRow): void {
    live.add(ws);
    unauth += 1;
    let counted = true;
    const uncount = (): void => {
      if (counted) {
        counted = false;
        unauth -= 1;
      }
    };
    ws.on('close', uncount);
    ws.on('close', () => live.delete(ws));
    ws.on('error', () => undefined);
    const deny = (reason: string): void => {
      void reason;
      uncount();
      ws.terminate();
    };

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
      const row = verified;
      if (setup.customParameters?.callId !== row.callId) return deny(REASON_AUTH);
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
          if (ENDED_STATUSES.has(found.status)) return 'denied' as const;
          await updateCall(tx, ctx, row.callSid, { status: 'ai', aiStartedAt: startedAt as Date });
          // Transcript is stored unless the caller already stopped recording or recording is off for the company.
          const rec = await findCallRecordingBySid(tx, ctx, row.callSid);
          const stopped = rec?.recordingStatus === 'stopped_by_caller';
          if (!stopped) {
            const [cs] = await tx
              .select({ days: companySettings.recordingRetentionDays })
              .from(companySettings)
              .where(eq(companySettings.companyId, ctx.companyId))
              .limit(1);
            if ((cs?.days ?? DEFAULT_RETENTION_DAYS) !== 0) await setCallRecording(tx, ctx, row.callSid, { transcriptStored: true });
          }
          return { found, stopped };
        });
        if (call === 'denied') {
          deps.relaySessions.remove(row.callSid);
          identity = null;
          return deny(REASON_AUTH);
        }
        if (call === null) return deny(REASON_AUTH);
        const recordingStopped = call.stopped;
        // The socket may have closed while withTenant ran; the close handler already removed the registry entry.
        if (stage === 'dead' || ws.readyState !== WebSocket.OPEN) return;
        stage = 'running';
        uncount();
        const recording = createRecording(deps, { callId: row.callId, companyId: row.companyId, callSid: row.callSid, stoppedByCaller: recordingStopped });
        loop = runRelayLoop(adapter, {
          deps,
          engine,
          recording,
          call: {
            callId: row.callId,
            companyId: row.companyId,
            callSid: row.callSid,
            from: call.found.fromE164,
            to: call.found.toE164,
            recordingStopped,
            messageOnly: setup.customParameters?.mode === 'message_only',
          },
        });
        deliver(setup);
        for (const m of queued.splice(0)) deliver(m);
        void recording.start();
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
        if (queued.length >= RELAY_MAX_QUEUED) {
          queued.length = 0;
          return deny(REASON_FLOOD);
        }
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

  const reject = (socket: Duplex): void => {
    try {
      socket.write(UNAUTHORIZED);
    } catch {
      // the socket is already gone
    }
    socket.destroy();
  };
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void upgrade(req, socket, head).catch(() => reject(socket));
  };
  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    socket.on('error', () => undefined);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== RELAY_PATH) {
      socket.write(REFUSED);
      socket.destroy();
      return;
    }
    // Every check that needs no database comes first: the shape, the Twilio signature header, and the token's
    // MAC over this call and company. A peer without a token we minted is refused here and never takes a slot
    // or a database query (pre-review notes 1 and 23).
    const t = url.searchParams.get('t');
    const c = url.searchParams.get('c');
    const o = url.searchParams.get('o');
    const header = req.headers['x-twilio-signature'];
    const sig = Array.isArray(header) ? header[0] : header;
    if (t === null || c === null || o === null || !UUID.test(c) || c !== c.toLowerCase() || !UUID.test(o) || o !== o.toLowerCase()) return reject(socket);
    if (typeof sig !== 'string' || sig === '') return reject(socket);
    if (!verifyRelayToken(deps.config.RELAY_TOKEN_SECRET, t, { callId: c, companyId: o }, deps.clock.now())) return reject(socket);
    if (unauth >= RELAY_MAX_UNAUTH) {
      socket.write(UNAVAILABLE);
      socket.destroy();
      return;
    }
    unauth += 1;
    let held = true;
    const release = (): void => {
      if (held) {
        held = false;
        unauth -= 1;
      }
    };
    try {
      const row = await relayCallById(deps.pools.system, c);
      if (row === null || row.companyId !== o || ENDED_STATUSES.has(row.status)) return reject(socket);
      const signer = await signingTokenFor(deps.pools.system, row.companyId, deps.config.TWILIO_AUTH_TOKEN, deps.config.ENCRYPTION_KEY);
      if (signer === null || !twilio.validateRequest(signer, sig, deps.config.RELAY_PUBLIC_URL + url.search, {})) return reject(socket);
      if (socket.destroyed) return;
      release();
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, row));
    } finally {
      release();
    }
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
