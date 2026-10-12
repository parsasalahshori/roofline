import type Anthropic from '@anthropic-ai/sdk';
import type { ConversationChannel } from '@roofline/shared';
import type { ConversationState } from './engine-types.ts';

/*
 * History helpers. Everything here only pushes: earlier entries are never edited, replaced or removed
 * (the preserved-thinking rule). Assistant content blocks are stored exactly as the model sent them.
 */

// Notes that arrived while the last history entry was not a user message. Kept off ConversationState.
const pendingNotes = new WeakMap<ConversationState, string[]>();
const personAskCountedTurn = new WeakSet<ConversationState>();
const understandingCountedTurn = new WeakSet<ConversationState>();

/** Called at the start of every turn: per-turn counter flags are cleared. */
export function beginTurn(state: ConversationState): void {
  personAskCountedTurn.delete(state);
  understandingCountedTurn.delete(state);
}
export function markPersonAskCounted(state: ConversationState): void {
  personAskCountedTurn.add(state);
}
export function personAskCounted(state: ConversationState): boolean {
  return personAskCountedTurn.has(state);
}
export function markUnderstandingCounted(state: ConversationState): void {
  understandingCountedTurn.add(state);
}
export function understandingCounted(state: ConversationState): boolean {
  return understandingCountedTurn.has(state);
}

export function newConversationState(i: {
  companyId: string;
  conversationId: string;
  channel: ConversationChannel;
  phone: string;
  callId: string | null;
  companyBlock: string;
  repName: string | null;
  startedAt: Date;
}): ConversationState {
  return {
    companyId: i.companyId,
    conversationId: i.conversationId,
    channel: i.channel,
    phone: i.phone,
    callId: i.callId,
    identity: 'unknown',
    customerId: null,
    shownIds: new Set<string>(),
    history: [],
    companyBlock: i.companyBlock,
    repName: i.repName,
    startedAt: i.startedAt,
    turns: 0,
    failedUnderstanding: 0,
    askedForPersonCount: 0,
    taskInProgress: false,
    nextPosition: 0,
    mode: 'normal',
    modelErrors: 0,
  };
}

function lastIsUser(state: ConversationState): boolean {
  return state.history[state.history.length - 1]?.role === 'user';
}

function pushNote(state: ConversationState, note: string): void {
  state.history.push({ role: 'system', content: note } as unknown as Anthropic.MessageParam);
}

export function appendUser(state: ConversationState, text: string): void {
  state.history.push({ role: 'user', content: text });
}

/**
 * Pushes the assistant's entry. Notes still queued (sent with the answer call that produced this reply, see
 * historyForAnswer) are committed first, so the history reads `user, system, assistant`, never `system, user`.
 */
export function appendAssistant(state: ConversationState, content: Anthropic.ContentBlock[]): void {
  commitSystemNotes(state);
  state.history.push({ role: 'assistant', content: content as unknown as Anthropic.MessageParam['content'] });
}

export function appendToolResults(
  state: ConversationState,
  results: { toolUseId: string; content: string; isError: boolean }[],
): void {
  const blocks = results.map((r) => ({
    type: 'tool_result' as const,
    tool_use_id: r.toolUseId,
    content: r.content,
    ...(r.isError ? { is_error: true } : {}),
  }));
  state.history.push({ role: 'user', content: blocks });
}

/** Notes are only queued here: historyForAnswer sends them, and appendAssistant commits them with the reply. */
export function appendSystemNote(state: ConversationState, note: string): void {
  const queued = pendingNotes.get(state) ?? [];
  queued.push(note);
  pendingNotes.set(state, queued);
}

/**
 * The history for an answer call: the stored history plus the queued notes, without committing them (RC-1 note 7).
 * A turn that ends with no assistant entry (interrupted before speech, a transfer route, spam) keeps its notes
 * queued for the next answer, so no committed history ever has a system entry followed by a user entry.
 */
export function historyForAnswer(state: ConversationState): Anthropic.MessageParam[] {
  const queued = pendingNotes.get(state);
  if (!queued || queued.length === 0 || !lastIsUser(state)) return [...state.history];
  return [...state.history, ...queued.map((n) => ({ role: 'system', content: n }) as unknown as Anthropic.MessageParam)];
}

/** Commits queued notes into the history, only right after a user entry (appendAssistant calls it). */
function commitSystemNotes(state: ConversationState): void {
  const queued = pendingNotes.get(state);
  if (!queued || queued.length === 0 || !lastIsUser(state)) return;
  pendingNotes.delete(state);
  for (const n of queued) pushNote(state, n);
}
