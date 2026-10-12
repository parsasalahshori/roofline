import { SentenceBuffer } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import type { RelayIn, VoiceSession } from '../providers/voice-session.ts';
import type { ConversationState, Engine } from './engine-types.ts';

/*
 * The conversation loop between one VoiceSession and the engine (D1 Task 11, package B).
 * The heartbeat/idle prompt, ai_seconds accounting, the live-call registry and the socket close live in
 * relay-server.ts (package C). Logs carry the call id and company id only: never transcript text,
 * phone numbers or tokens.
 */
export type RelayCall = { callId: string; companyId: string; callSid: string; from: string; to: string; messageOnly: boolean };

export type RelayLoop = {
  /** Resolves when the in-flight turn (if any) has been drained and saved. */
  settled(): Promise<void>;
  /** True once the loop has sent an `end` message. */
  readonly ended: boolean;
};

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * Runs one call's conversation over `session`. Registers session.onMessage; on `setup` starts the
 * engine conversation. Does NOT own the socket close, idle timers, DB accounting or the registry.
 */
export function runRelayLoop(session: VoiceSession, o: { deps: AppDeps; engine: Engine; call: RelayCall }): RelayLoop {
  void o.deps;
  const { engine, call } = o;
  let state: ConversationState | null = null;
  let setupSeen = false;
  let ended = false;
  let closed = false;
  let current: AbortController | null = null;
  let turnPromise: Promise<void> = Promise.resolve();
  let chain: Promise<void> = Promise.resolve();

  const endForm = (kind: 'transfer' | 'end'): 'transfer' | 'end' => (call.messageOnly ? 'end' : kind);

  function sendEnd(handoffData: Record<string, string>): void {
    if (ended) return;
    ended = true;
    session.send({ type: 'end', handoffData: JSON.stringify(handoffData) });
  }

  function transfer(reason: string, summary: string): void {
    if (endForm('transfer') === 'transfer') sendEnd({ kind: 'transfer', reason, summary });
    else sendEnd({ kind: 'end', reason });
  }

  function sendText(text: string): void {
    const buf = new SentenceBuffer();
    const sentences = [...buf.push(text), ...buf.flush()];
    if (sentences.length <= 1) {
      session.send({ type: 'text', token: text, last: false });
      return;
    }
    for (const s of sentences) session.send({ type: 'text', token: s, last: false });
  }

  async function runTurn(st: ConversationState, text: string, ac: AbortController): Promise<void> {
    let spoke = false;
    let finishedByEnd = false;
    try {
      // Drain to the end even after a handoff/end: the turn row is saved after the last event.
      for await (const ev of engine.turn(st, text, ac.signal)) {
        if (ev.type === 'say' || ev.type === 'filler') {
          if (ended) continue;
          spoke = true;
          sendText(ev.text);
        } else if (ev.type === 'handoff') {
          if (ended) continue;
          finishedByEnd = true;
          transfer(ev.reason, ev.summary);
        } else if (ev.type === 'end') {
          if (ended) continue;
          finishedByEnd = true;
          sendEnd({ kind: 'end', reason: ev.reason });
        }
      }
      if (spoke && !finishedByEnd && !ended) session.send({ type: 'text', token: '', last: true });
    } catch (e) {
      if (isAbort(e) || ac.signal.aborted) return;
      console.error(`relay turn failed call=${call.callId} company=${call.companyId}`);
      transfer('asked', '');
    }
  }

  function abortCurrent(): void {
    current?.abort();
  }

  async function handle(m: RelayIn): Promise<void> {
    switch (m.type) {
      case 'setup': {
        if (setupSeen) return;
        setupSeen = true;
        if (m.customParameters?.callId !== call.callId) {
          session.close();
          return;
        }
        state = await engine.start({
          companyId: call.companyId,
          channel: 'voice',
          phone: call.from,
          callId: call.callId,
          companyNumber: call.to,
        });
        return;
      }
      case 'prompt': {
        if (!m.last || !state || ended || closed) return;
        abortCurrent();
        const ac = new AbortController();
        current = ac;
        const st = state;
        const prev = turnPromise;
        turnPromise = prev.then(() => (ended || closed || ac.signal.aborted ? undefined : runTurn(st, m.voicePrompt, ac)));
        return;
      }
      case 'interrupt': {
        if (!state) return;
        abortCurrent();
        await turnPromise;
        await engine.interrupted(state, m.utteranceUntilInterrupt);
        return;
      }
      case 'dtmf': {
        if (m.digit !== '0' || ended) return;
        abortCurrent();
        transfer('asked', '');
        return;
      }
      case 'error':
        console.error(`relay error call=${call.callId} company=${call.companyId}`);
        return;
    }
  }

  session.onMessage((m) => {
    chain = chain.then(() => handle(m)).catch(() => {
      console.error(`relay turn failed call=${call.callId} company=${call.companyId}`);
    });
  });
  session.onClose(() => {
    closed = true;
    abortCurrent();
  });

  return {
    async settled() {
      let seen: Promise<void>;
      do {
        seen = chain;
        await seen;
        await turnPromise;
      } while (seen !== chain);
    },
    get ended() {
      return ended;
    },
  };
}
