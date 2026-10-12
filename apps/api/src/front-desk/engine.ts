import type Anthropic from '@anthropic-ai/sdk';
import {
  FRONT_DESK_TOOLS,
  type FrontDeskToolName,
  guardSentence,
  ASK_PERSON_INTENTS,
  type GuardHit,
  SentenceBuffer,
  shouldTransfer,
  type TransferReason,
  turnLimit,
  type TurnRoute,
} from '@roofline/shared';
import {
  findCallConversationId,
  getConversation,
  insertConversation,
  insertTurn,
  linkCallConversation,
  loadCompanyFacts,
  setCallSpamReason,
  updateConversation,
  updateTurn,
  withTenant,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import type { LlmEvent, RouteDecision, TurnUsage } from '../providers/llm.ts';
import { summarize } from './engine-state.ts';
import type {
  CompanyBlockInput,
  ConversationState,
  Engine,
  EngineEvent,
  ToolHandlers,
  ToolResult,
} from './engine-types.ts';
import { fillerFor } from './fillers.ts';
import { toolNamesFor } from './tools/index.ts';
import { buildCompanyBlock } from './prompt.ts';
import {
  appendAssistant,
  appendSystemNote,
  appendToolResults,
  appendUser,
  beginTurn,
  flushSystemNotes,
  markPersonAskCounted,
  markUnderstandingCounted,
  newConversationState,
} from './state.ts';
import { systemCtx } from './tools/system-ctx.ts';

const DEFAULT_SERVICES = ['Roof inspections', 'Storm and hail damage inspections', 'Repairs', 'Roof replacement'];
const MAX_TOOL_ROUNDS = 4;
const NOT_THEIRS = "That isn't one of this caller's records.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAY_REFUSAL = 'Let me get someone who can help with that.';
const SAY_MAX_TOKENS = 'Sorry — let me put that more simply.';
const SAY_TROUBLE = "Sorry, I'm having trouble on my end. Let me get someone for you.";
const SAY_GOODBYE = 'Thank you for calling. Goodbye.';
export const SAY_SPAM_ENDING = 'Thank you for calling. We are not interested in this, so we will end the call now. Goodbye.';
/** Router intents that end the call politely and mark it spam (Decision 13). */
const SPAM_INTENTS = new Set(['spam', 'sales_pitch']);
const NOTE_SHORT = 'Answer in one or two short sentences.';
const NOTE_OFFER = 'Offer a person or a message.';

type ToolUse = { id: string; name: FrontDeskToolName; input: unknown };
type StreamOutcome =
  | { ok: true; stopReason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens'; usage: TurnUsage; content: Anthropic.ContentBlock[]; toolUses: ToolUse[] }
  | { ok: false; err: unknown };
type Stream = { iter: AsyncIterator<LlmEvent>; first: Promise<IteratorResult<LlmEvent>>; ac: AbortController };

/** What one turn collects for the saved rows. */
type TurnRecord = {
  route: TurnRoute;
  routerMs: number | null;
  model: string | null;
  firstTokenMs: number | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  usageSeen: boolean;
  said: string[];
  guardHits: Set<GuardHit>;
  toolCalls: { name: string; input: unknown; result: string; ok: boolean }[];
};

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Every string under a key ending in "Id" (except slotUserId) that looks like a UUID. */
function idsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) idsIn(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as object)) {
      if (typeof v === 'string') {
        if (k.endsWith('Id') && k !== 'slotUserId' && UUID.test(v)) out.push(v);
      } else idsIn(v, out);
    }
  }
  return out;
}

export function createEngine(deps: AppDeps, tools: ToolHandlers): Engine {
  const lastAssistantTurn = new WeakMap<ConversationState, string>();

  async function start(i: { companyId: string; channel: 'voice' | 'sms'; phone: string; callId?: string; companyNumber?: string }): Promise<ConversationState> {
    const ctx = systemCtx(i.companyId);
    return withTenant(deps.pools, ctx, async (tx) => {
      const facts = await loadCompanyFacts(tx, ctx);
      const companyNumber = i.companyNumber ?? facts.companyNumberE164;
      if (!companyNumber) throw new Error('This company has no phone number for the front desk.');
      const input: CompanyBlockInput = {
        name: facts.name,
        timezone: facts.timezone,
        city: facts.city,
        state: facts.state,
        workHours: facts.workHours,
        facts: facts.facts,
        services: DEFAULT_SERVICES,
        towns: facts.city ? [facts.city] : [],
        repName: null,
        canMove: facts.canMove,
        canCancel: facts.canCancel,
      };
      const companyBlock = buildCompanyBlock(input);
      // A call row links to its conversation once: a second start for the same call reuses it.
      let id: string | null = null;
      if (i.callId !== undefined) {
        const linked = await findCallConversationId(tx, ctx, i.callId);
        if (linked !== null) id = (await getConversation(tx, ctx, linked))?.id ?? null;
      }
      if (id === null) {
        id = (
          await insertConversation(tx, ctx, {
            channel: i.channel,
            phoneE164: i.phone,
            companyNumberE164: companyNumber,
          })
        ).id;
        if (i.callId !== undefined) await linkCallConversation(tx, ctx, i.callId, id);
      }
      const created = newConversationState({
        companyId: i.companyId,
        conversationId: id,
        channel: i.channel,
        phone: i.phone,
        callId: i.callId ?? null,
        companyBlock,
        repName: null,
        startedAt: deps.clock.now(),
      });
      created.toolSettings = { canMove: facts.canMove, canCancel: facts.canCancel };
      return created;
    });
  }

  async function* turn(state: ConversationState, callerText: string, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    const startedMs = performance.now();
    const minutes = (deps.clock.now().getTime() - state.startedAt.getTime()) / 60_000;
    const limit = turnLimit({ turns: state.turns, minutes });
    if (limit === 'end') {
      yield { type: 'end', reason: 'limit' };
      return;
    }
    beginTurn(state);
    if (limit === 'offer_person') appendSystemNote(state, NOTE_OFFER);
    appendUser(state, callerText);

    const rec: TurnRecord = {
      route: 'opus',
      routerMs: null,
      model: null,
      firstTokenMs: null,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      usageSeen: false,
      said: [],
      guardHits: new Set(),
      toolCalls: [],
    };
    const controllers: AbortController[] = [];
    const onAbort = () => controllers.forEach((c) => c.abort());
    signal.addEventListener('abort', onAbort, { once: true });
    const chain = (): AbortController => {
      const c = new AbortController();
      controllers.push(c);
      if (signal.aborted) c.abort();
      return c;
    };

    const speak = (text: string, type: 'say' | 'filler' = 'say'): { type: 'say' | 'filler'; text: string } => {
      const g = guardSentence(text, { repName: state.repName });
      for (const h of g.hits) rec.guardHits.add(h);
      rec.said.push(g.text);
      return { type, text: g.text };
    };

    /** Marks the conversation and the call as spam (the engine's polite-ending path). Errors are logged, as the turn save does. */
    const markSpam = async (): Promise<void> => {
      try {
        const ctx = systemCtx(state.companyId);
        await withTenant(deps.pools, ctx, async (tx) => {
          await updateConversation(tx, ctx, state.conversationId, { outcome: 'spam' });
          if (state.callId !== null) await setCallSpamReason(tx, ctx, state.callId, 'assistant_spam');
        });
      } catch (err) {
        deps.logError?.(err, 'front-desk.spam');
      }
    };

    const toolNames: FrontDeskToolName[] = toolNamesFor(state.channel, state.toolSettings ?? { canMove: false, canCancel: false });

    // The answer call always happens inside a try: an unconfigured Llm throws from answer() itself.
    const openStream = (): Stream => {
      const ac = chain();
      let iter: AsyncIterator<LlmEvent>;
      let first: Promise<IteratorResult<LlmEvent>>;
      try {
        flushSystemNotes(state);
        const answer = deps.llm.answer({
          companyId: state.companyId,
          companyBlock: state.companyBlock,
          history: [...state.history],
          tools: toolNames,
          signal: ac.signal,
        });
        iter = answer[Symbol.asyncIterator]();
        first = iter.next();
      } catch (err) {
        iter = { next: () => Promise.reject(err) };
        first = Promise.reject(err);
      }
      first.catch(() => undefined);
      return { iter, first, ac };
    };

    const addUsage = (u: TurnUsage) => {
      rec.model = u.model;
      rec.usageSeen = true;
      rec.inputTokens += u.inputTokens;
      rec.cachedTokens += u.cachedTokens;
      rec.outputTokens += u.outputTokens;
      if (rec.firstTokenMs === null) rec.firstTokenMs = u.firstTokenMs;
    };

    async function* consume(stream: Stream): AsyncGenerator<EngineEvent, StreamOutcome> {
      const buf = new SentenceBuffer();
      const toolUses: ToolUse[] = [];
      let pending: Promise<IteratorResult<LlmEvent>> | null = stream.first;
      try {
        for (;;) {
          const r: IteratorResult<LlmEvent> = await (pending ?? stream.iter.next());
          pending = null;
          if (r.done) break;
          const ev = r.value;
          if (ev.type === 'text') {
            for (const s of buf.push(ev.text)) yield speak(s);
          } else if (ev.type === 'tool_use') {
            toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
          } else {
            for (const s of buf.flush()) yield speak(s);
            return { ok: true, stopReason: ev.stopReason, usage: ev.usage, content: ev.assistantContent, toolUses };
          }
        }
        return { ok: false, err: new Error('The answer stream ended without a done event.') };
      } catch (err) {
        return { ok: false, err };
      }
    }

    async function* handoff(reason: TransferReason, summary: string): AsyncGenerator<EngineEvent> {
      yield { type: 'handoff', reason, summary };
    }

    async function* run(): AsyncGenerator<EngineEvent> {
      const routeAc = chain();
      const routeStart = performance.now();
      let routeP: Promise<RouteDecision & { usage: TurnUsage }>;
      try {
        routeP = deps.llm.route({ companyBlock: state.companyBlock, state: summarize(state), callerText, channel: state.channel }, routeAc.signal);
      } catch (err) {
        routeP = Promise.reject(err);
      }
      routeP.catch(() => undefined);
      const speculative = openStream();

      let decision: (RouteDecision & { usage: TurnUsage }) | null = null;
      try {
        decision = await routeP;
        rec.routerMs = Math.round(performance.now() - routeStart);
      } catch (err) {
        if (signal.aborted || isAbort(err)) return;
        deps.relaySessions.recordLlmFailure(deps.clock.now()); // non-fatal: Opus answers without a route
      }
      if (signal.aborted) return;

      const dropSpeculative = () => {
        speculative.ac.abort();
        void Promise.resolve(speculative.iter.return?.(undefined)).catch(() => undefined);
      };

      if (decision) {
        // Task 6 carry: count person-asks and misunderstandings once per turn, before shouldTransfer.
        if (ASK_PERSON_INTENTS.has(decision.intent)) {
          state.askedForPersonCount += 1;
          markPersonAskCounted(state);
        }
        if (decision.intent === 'not_understood') {
          state.failedUnderstanding += 1;
          markUnderstandingCounted(state);
        } else state.failedUnderstanding = 0;
      }

      if (decision && SPAM_INTENTS.has(decision.intent)) {
        dropSpeculative();
        rec.route = 'end';
        // The goodbye is spoken on calls only; a spam text gets no reply at all.
        if (state.channel === 'voice') {
          const ev = speak(SAY_SPAM_ENDING);
          appendAssistant(state, [{ type: 'text', text: ev.text }] as unknown as Anthropic.ContentBlock[]);
          yield ev;
        }
        await markSpam();
        yield { type: 'end', reason: 'spam' };
        return;
      }
      if (decision && decision.route === 'fast' && decision.fastReply) {
        dropSpeculative();
        rec.route = 'fast';
        const ev = speak(decision.fastReply);
        appendAssistant(state, [{ type: 'text', text: ev.text }] as unknown as Anthropic.ContentBlock[]);
        yield ev;
        return;
      }
      if (decision && decision.route === 'end') {
        dropSpeculative();
        rec.route = 'end';
        const ev = speak(decision.fastReply ?? SAY_GOODBYE);
        appendAssistant(state, [{ type: 'text', text: ev.text }] as unknown as Anthropic.ContentBlock[]);
        yield ev;
        yield { type: 'end', reason: 'goodbye' };
        return;
      }
      if (decision && decision.route === 'transfer') {
        dropSpeculative();
        rec.route = 'transfer';
        const reason =
          shouldTransfer({
            intent: decision.intent,
            urgent: decision.urgent,
            mood: decision.mood,
            askedForPersonCount: state.askedForPersonCount,
            taskInProgress: state.taskInProgress,
            failedUnderstanding: state.failedUnderstanding,
          }) ?? 'asked';
        yield* handoff(reason, `The caller needs a person (${decision.intent}).`);
        return;
      }
      if (decision && decision.route === 'opus') {
        // Counts alone can end the call: a repeated person-ask, or three turns in a row not understood.
        const byCount = shouldTransfer({
          intent: 'other',
          urgent: false,
          mood: 'calm',
          askedForPersonCount: ASK_PERSON_INTENTS.has(decision.intent) ? state.askedForPersonCount : 0,
          taskInProgress: state.taskInProgress,
          failedUnderstanding: state.failedUnderstanding,
        });
        if (byCount) {
          dropSpeculative();
          rec.route = 'transfer';
          yield* handoff(byCount, `The caller needs a person (${decision.intent}).`);
          return;
        }
      }
      // Opus route (or the router was unavailable).
      let stream = speculative;
      let rounds = 0;
      let invalidInputs = 0;
      let shortened = false;
      for (;;) {
        const saidBefore = rec.said.length;
        const out: StreamOutcome = yield* consume(stream);
        if (signal.aborted) {
          const heard = rec.said.slice(saidBefore).join(' ').trim();
          if (heard && state.history[state.history.length - 1]?.role !== 'assistant') {
            appendAssistant(state, [{ type: 'text', text: heard }] as unknown as Anthropic.ContentBlock[]);
            appendSystemNote(state, 'The caller interrupted you. They heard only the part you had said so far.');
          }
          return;
        }
        if (!out.ok) {
          deps.relaySessions.recordLlmFailure(deps.clock.now());
          state.modelErrors += 1;
          if (state.modelErrors >= 2) {
            yield speak(SAY_TROUBLE);
            yield* handoff('model_failure', 'The assistant had trouble answering and needs a person to take over.');
            return;
          }
          stream = openStream();
          continue;
        }
        deps.relaySessions.recordLlmSuccess(deps.clock.now());
        state.modelErrors = 0;
        addUsage(out.usage);

        if (out.stopReason === 'refusal') {
          if (out.content.length > 0) appendAssistant(state, out.content);
          yield speak(SAY_REFUSAL);
          yield* handoff('model_failure', 'The assistant could not help with this request and needs a person to take over.');
          return;
        }
        if (out.stopReason === 'max_tokens') {
          if (shortened) {
            yield* handoff('model_failure', 'The assistant could not finish an answer and needs a person to take over.');
            return;
          }
          shortened = true;
          yield speak(SAY_MAX_TOKENS);
          // The cut-off answer is not echoed back: it may end inside a block. The note follows the last user message.
          appendSystemNote(state, NOTE_SHORT);
          stream = openStream();
          continue;
        }
        if (out.stopReason !== 'tool_use' || out.toolUses.length === 0) {
          appendAssistant(state, out.content);
          return;
        }

        // Tool round.
        rounds += 1;
        if (rounds > MAX_TOOL_ROUNDS) {
          yield* handoff('not_understood', 'The assistant took too many steps and needs a person to take over.');
          return;
        }
        appendAssistant(state, out.content);
        const results: { toolUseId: string; content: string; isError: boolean }[] = [];
        let finish: EngineEvent | null = null;
        for (const use of out.toolUses) {
          const filler = fillerFor(use.name);
          if (filler !== null) yield speak(filler, 'filler');
          const parsed = FRONT_DESK_TOOLS[use.name].input.safeParse(use.input);
          let result: ToolResult;
          if (!parsed.success) {
            invalidInputs += 1;
            result = { ok: false, forModel: 'Those details were not valid. Check them and try once more.' };
            if (invalidInputs > 1) finish = { type: 'handoff', reason: 'not_understood', summary: 'The assistant could not fill in the details and needs a person to take over.' };
          } else if (idsIn(parsed.data).some((id) => !state.shownIds.has(id))) {
            result = { ok: false, forModel: NOT_THEIRS };
          } else {
            const handler = tools[use.name] as ((ctx: unknown, input: unknown) => Promise<ToolResult>) | undefined;
            if (!toolNames.includes(use.name as FrontDeskToolName)) {
              result = { ok: false, forModel: 'That is not available.' };
            } else if (!handler) {
              result = { ok: false, forModel: 'That is not available right now.' };
            } else {
              try {
                result = await handler({ deps, companyId: state.companyId, conversation: state, now: deps.clock.now() }, parsed.data);
              } catch (err) {
                deps.logError?.(err, 'front-desk.tool');
                result = { ok: false, forModel: 'That did not work. Tell the caller you could not do it just now.' };
              }
            }
            for (const id of result.shownIds ?? []) state.shownIds.add(id);
            if (use.name === 'transfer_to_person' && !finish) {
              const p = parsed.data as { reason: Exclude<TransferReason, 'model_failure'>; summary: string };
              finish = { type: 'handoff', reason: p.reason, summary: p.summary };
            } else if (use.name === 'end_call' && !finish) {
              finish = { type: 'end', reason: (parsed.data as { reason: 'goodbye' | 'spam' | 'silence' }).reason };
            }
          }
          rec.toolCalls.push({ name: use.name, input: use.input, result: result.forModel, ok: result.ok });
          results.push({ toolUseId: use.id, content: result.forModel, isError: !result.ok });
        }
        appendToolResults(state, results);
        if (finish) {
          if (finish.type === 'end' && finish.reason === 'spam') await markSpam();
          yield finish;
          return;
        }
        stream = openStream();
      }
    }

    try {
      yield* run();
    } finally {
      signal.removeEventListener('abort', onAbort);
      controllers.forEach((c) => c.abort());
    }

    // Save the turn: one transaction, caller row then assistant row.
    const hits = [...rec.guardHits];
    const text = rec.said.join(' ');
    try {
      const ctx = systemCtx(state.companyId);
      const ids = await withTenant(deps.pools, ctx, async (tx) => {
        const caller = await insertTurn(tx, ctx, {
          conversationId: state.conversationId,
          callId: state.callId,
          speaker: 'caller',
          text: state.transcriptOff === true ? '' : callerText,
          at: deps.clock.now(),
          route: rec.route,
        });
        if (rec.said.length === 0 && rec.toolCalls.length === 0) return { caller: caller.id, assistant: null, rows: 1 };
        const assistant = await insertTurn(tx, ctx, {
          conversationId: state.conversationId,
          callId: state.callId,
          speaker: 'assistant',
          text: state.transcriptOff === true ? '' : text,
          at: deps.clock.now(),
          model: rec.model,
          route: rec.route,
          routerMs: rec.routerMs,
          firstTokenMs: rec.firstTokenMs,
          totalMs: Math.round(performance.now() - startedMs),
          inputTokens: rec.usageSeen ? rec.inputTokens : null,
          cachedTokens: rec.usageSeen ? rec.cachedTokens : null,
          outputTokens: rec.usageSeen ? rec.outputTokens : null,
          toolCalls: rec.toolCalls.length > 0 ? rec.toolCalls : null,
          guardHits: hits,
        });
        return { caller: caller.id, assistant: assistant.id, rows: 2 };
      });
      state.nextPosition += ids.rows;
      state.turns += 1;
      const turnId = ids.assistant ?? ids.caller;
      if (ids.assistant) lastAssistantTurn.set(state, ids.assistant);
      yield { type: 'turn_saved', turnId };
    } catch (err) {
      state.turns += 1;
      const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      const where = 'front-desk.save-turn ' + state.conversationId + (state.callId ? ' ' + state.callId : '');
      deps.logError?.(err, where);
      if (code === '23505') throw err;
    }
  }

  async function interrupted(state: ConversationState, spoken: string): Promise<void> {
    const id = lastAssistantTurn.get(state);
    if (!id) return;
    const ctx = systemCtx(state.companyId);
    // Only the saved row changes; state.history stays as it is.
    await withTenant(deps.pools, ctx, (tx) => updateTurn(tx, ctx, id, { text: spoken, truncated: true }));
  }

  return {
    start,
    turn,
    interrupted,
    note(state, systemNote) {
      appendSystemNote(state, systemNote);
    },
  };
}
