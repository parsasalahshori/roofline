import type Anthropic from '@anthropic-ai/sdk';
import type { ConversationChannel } from '@roofline/shared';
import type { ConversationState } from './engine-types.ts';

/*
 * History helpers. Everything here only pushes: earlier entries are never edited, replaced or removed
 * (the preserved-thinking rule). Assistant content blocks are stored exactly as the model sent them.
 */

// Notes that arrived while the last history entry was not a user message. Kept off ConversationState.
const pendingNotes = new WeakMap<ConversationState, string[]>();

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
  const queued = pendingNotes.get(state);
  if (queued && queued.length > 0) {
    pendingNotes.delete(state);
    for (const n of queued) pushNote(state, n);
  }
}

export function appendAssistant(state: ConversationState, content: Anthropic.ContentBlock[]): void {
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

/** A system note may only follow a user message; otherwise it waits for the next one. */
export function appendSystemNote(state: ConversationState, note: string): void {
  if (lastIsUser(state)) {
    pushNote(state, note);
    return;
  }
  const queued = pendingNotes.get(state) ?? [];
  queued.push(note);
  pendingNotes.set(state, queued);
}
