import type Anthropic from '@anthropic-ai/sdk';
import {
  getConversation,
  listConversationTexts,
  listUnansweredInbound,
  loadCompanyFacts,
  lastTeamReplyAt,
  frontDeskTextsOn,
  insertAssistantText,
  isNumberBlocked,
  listTurns,
  loadStoredIdentity,
  loadTurnStats,
  lockRecipient,
  matchCustomersByPhone,
  saveCallerIdentity,
  type Tx,
  updateConversation,
  withTenant,
} from '@roofline/db';
import { turnLimit } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { buildGateRequest } from '../messaging/gate-request.ts';
import { sendQueuedText, textStateFor } from '../messaging/outbound.ts';
import { createEngine } from './engine.ts';
import type { Engine } from './engine-types.ts';
import { buildCompanyBlock } from './prompt.ts';
import { confirmByText, isConfirmShortcut } from './tools/confirm.ts';
import { FRONT_DESK_HANDLERS } from './tools/index.ts';
import { systemCtx } from './tools/system-ctx.ts';
import { appendAssistant, appendUser, newConversationState } from './state.ts';

/*
 * D1 Task 14: the text channel. Inbound texts of a Front Desk conversation are answered by one
 * debounced `fd-text` job per conversation: every unanswered inbound text becomes ONE turn and ONE
 * reply, which goes out through the F1 send gate as `informational`.
 */

/**
 * Marker the inbound hook passes: set `consumed: true` when an earlier handler (S1's onStormReply,
 * G1's claims hook) already answered the message, so Front Desk must not answer it again.
 */
export type InboundConsumption = { consumed: boolean };

export type QueueFrontDeskTextOpts = {
  /** Where the debounced fd-text job goes (deps.jobs). Without it nothing is queued. */
  jobs?: JobQueue;
  /** True when an earlier handler (S1, G1) already consumed the message: nothing is queued. */
  consumed?: boolean;
};

/** The stored inbound message the hook just inserted. */
export type InboundMessageRef = { id: string; conversationId: string; companyId: string };

/** Debounce before the fd-text job runs, in seconds. */
export const FD_TEXT_DEBOUNCE_SECONDS = 20;

/**
 * Queues the debounced fd-text job for the message's conversation. Idempotent per message: calling it again for the
 * same message (before or after the job runs) never produces a second reply, because the job key is per conversation
 * (one waiting job answers every unanswered text in one turn) and the reply is deduped by `fd-text:<last unanswered
 * message id>`. Passing `consumed: true` (an earlier handler, S1 onStormReply or G1 claims, already answered) queues
 * nothing. G1 may call it directly.
 */
export async function queueFrontDeskText(_tx: Tx, message: InboundMessageRef, opts?: QueueFrontDeskTextOpts): Promise<void> {
  if (opts?.consumed === true || opts?.jobs === undefined) return;
  await opts.jobs.send(
    'fd-text',
    { companyId: message.companyId, conversationId: message.conversationId },
    { singletonKey: `fd-text:${message.conversationId}`, startAfter: FD_TEXT_DEBOUNCE_SECONDS },
  );
}

/** The engine offers only TEXT_CHANNEL_TOOLS on the sms channel. */
const TEXT_TOOL_HANDLERS = FRONT_DESK_HANDLERS;

const TEAM_QUIET_MS = 2 * 60 * 60 * 1000;
const HISTORY_TEXTS = 20;
const MAX_REPLY_CHARS = 306; // two 153-character segments

/** A text thread never gets more than this many AI turns (one per caller turn), whatever the clock says. */
export const SMS_MAX_AI_TURNS = 40;

/** Keeps whole sentences while they fit in two segments; the first sentence is always kept whole. */
function fitSegments(reply: string): string {
  if (reply.length <= MAX_REPLY_CHARS) return reply;
  const sentences = reply.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)\s*/g) ?? [reply];
  let out = '';
  for (const raw of sentences) {
    const next = (out === '' ? '' : `${out} `) + raw.trim();
    if (out !== '' && next.length > MAX_REPLY_CHARS) break;
    out = next;
  }
  return out;
}

/** The fd-text job handler (wired in jobs/handlers.ts). `engine` lets tests inject one. */
export async function runFrontDeskText(
  deps: AppDeps,
  data: { companyId: string; conversationId?: string },
  engine?: Engine,
): Promise<void> {
  const conversationId = data.conversationId;
  if (conversationId === undefined) return;
  const ctx = systemCtx(data.companyId);
  const now = deps.clock.now();

  const prepared = await withTenant(deps.pools, ctx, async (tx) => {
    const conversation = await getConversation(tx, ctx, conversationId);
    if (!conversation || conversation.status !== 'active') return null;
    // The manual open-ended 'Team is handling' switch (no teamUntil) stays silent; a timed handoff whose teamUntil is
    // set falls through to the 2-hour quiet check on the team's last reply below.
    if (conversation.handledBy === 'team' && conversation.teamUntil === null) return null;
    if (await isNumberBlocked(tx, ctx, conversation.phoneE164)) return null;
    if (!(await frontDeskTextsOn(tx, ctx))) return null;
    const unanswered = await listUnansweredInbound(tx, ctx, conversationId);
    if (unanswered.length === 0) return null;
    const teamAt = await lastTeamReplyAt(tx, ctx, conversationId);
    if (teamAt && now.getTime() - teamAt.getTime() < TEAM_QUIET_MS) return null;

    const stats = await loadTurnStats(tx, ctx, conversationId);
    const minutes = (now.getTime() - conversation.createdAt.getTime()) / 60_000;
    // The engine checks the same rule; stopping here spends nothing on a thread that is over its limits.
    if (stats.callerTurns >= SMS_MAX_AI_TURNS) return null;
    if (turnLimit({ turns: stats.callerTurns, minutes }) === 'end') return null;

    const facts = await loadCompanyFacts(tx, ctx);
    const companyBlock = buildCompanyBlock({
      name: facts.name,
      timezone: facts.timezone,
      city: facts.city,
      state: facts.state,
      workHours: facts.workHours,
      facts: facts.facts,
      services: ['Roof inspections', 'Storm damage repair'],
      towns: facts.city ? [facts.city] : [],
      repName: null,
      canMove: facts.canMove,
      canCancel: facts.canCancel,
    });
    // Not engine.start: that would insert a second conversation row.
    const state = newConversationState({
      companyId: data.companyId,
      conversationId,
      channel: 'sms',
      phone: conversation.phoneE164,
      callId: null,
      companyBlock,
      repName: null,
      startedAt: conversation.createdAt,
    });
    state.customerId = conversation.customerId;
    state.nextPosition = stats.nextPosition;
    state.turns = stats.callerTurns;
    const stored = await loadStoredIdentity(tx, ctx, conversationId);
    if (stored) {
      state.identity = stored.identity;
      state.customerId = stored.customerId ?? conversation.customerId;
      state.verifyFailures = stored.verifyFailures;
    }
    if (state.customerId === null) {
      // Unknown texters get no reply until a customer record exists; exactly one phone match identifies them.
      const matches = await matchCustomersByPhone(tx, ctx, conversation.phoneE164);
      if (matches.length !== 1) return null;
      state.customerId = matches[0]!.customerId;
      state.identity = 'matched';
      await saveCallerIdentity(tx, ctx, conversationId, { identity: 'matched', customerId: state.customerId });
    } else if (state.identity === 'unknown') {
      // The inbound hook linked the customer by phone; record that as 'matched' so it survives the next text.
      state.identity = 'matched';
      await saveCallerIdentity(tx, ctx, conversationId, { identity: 'matched', customerId: state.customerId });
    }
    state.toolSettings = { canMove: facts.canMove, canCancel: facts.canCancel };
    const firstUnanswered = unanswered[0]!;
    const storedTurns = await listTurns(tx, ctx, conversationId);
    if (storedTurns.length > 0) {
      // The engine's own stored turns are the history (never also the texts: that would seed it twice).
      for (const turn of storedTurns) {
        if (turn.text.trim() === '') continue;
        if (turn.speaker === 'caller') appendUser(state, turn.text);
        else if (turn.speaker === 'assistant') {
          appendAssistant(state, [{ type: 'text', text: turn.text }] as unknown as Anthropic.ContentBlock[]);
        }
      }
    } else {
      // First exchange, or a thread from before turns were stored: fall back to the text messages.
      const earlier = await listConversationTexts(tx, ctx, conversationId, HISTORY_TEXTS);
      for (const text of earlier) {
        if (text.createdAt.getTime() >= firstUnanswered.createdAt.getTime()) continue;
        if (text.direction === 'in') appendUser(state, text.body);
        else if (text.assistant) {
          appendAssistant(state, [{ type: 'text', text: text.body }] as unknown as Anthropic.ContentBlock[]);
        }
      }
    }
    return {
      state,
      customerId: state.customerId,
      toE164: conversation.phoneE164,
      callerText: unanswered.map((u) => u.body).join('\n'),
      lastUnanswered: unanswered[unanswered.length - 1]!,
    };
  });
  if (!prepared) return;

  const { state, callerText, lastUnanswered, toE164 } = prepared;
  const active = engine ?? createEngine(deps, TEXT_TOOL_HANDLERS);
  const said: string[] = [];
  let handoff = false;
  let spam = false;
  let turnSaved = false;
  if (prepared.customerId !== null && isConfirmShortcut(callerText)) {
    // "C" or "confirm" from a customer's own number confirms their next visit; the engine is not asked.
    said.push(await confirmByText(deps, { companyId: data.companyId, conversationId, customerId: prepared.customerId }, deps.clock.now()));
  } else {
    for await (const event of active.turn(state, callerText, new AbortController().signal)) {
      if (event.type === 'say') said.push(event.text);
      else if (event.type === 'turn_saved') turnSaved = true;
      else if (event.type === 'handoff') handoff = true;
      else if (event.type === 'end' && event.reason === 'spam') spam = true;
    }
  }
  if (spam) {
    // Spam is never answered: end the conversation so later texts from the number open a new one.
    await withTenant(deps.pools, ctx, (tx) => updateConversation(tx, ctx, conversationId, { status: 'ended' }));
    return;
  }
  if (handoff) {
    await withTenant(deps.pools, ctx, (tx) => updateConversation(tx, ctx, conversationId, { handledBy: 'team' }));
  }

  const reply = fitSegments(said.join(' ').trim());
  if (reply === '') return;
  const customerId = prepared.customerId;
  if (customerId === null) return;
  // Stored means the engine kept this exchange (an assistant turn exists), so the reply must not be thrown away.
  const stored = said.length > 0 || turnSaved;
  let newerPending = false;

  const dedupeKey = `fd-text:${lastUnanswered.id}`;
  const sendAt = deps.clock.now();
  const outcome = await withTenant(deps.pools, ctx, async (tx) => {
    await lockRecipient(tx, ctx, customerId);
    // A text that arrives mid-turn would otherwise look answered: the reply's createdAt is later than that text.
    const fresh = await listUnansweredInbound(tx, ctx, conversationId);
    const freshLast = fresh[fresh.length - 1];
    if (freshLast === undefined) return null;
    let replyAt = sendAt;
    if (freshLast.id !== lastUnanswered.id) {
      // A newer text arrived mid-turn. Nothing stored: the turn is redone for both texts (requeue below).
      if (!stored) return { requeue: true as const };
      // The assistant turn is stored, so redoing it would double it: send this reply for lastUnanswered, stamped just
      // after that text so the newer one still counts as unanswered, and queue a job for the newer text.
      newerPending = true;
      replyAt = new Date(lastUnanswered.createdAt.getTime() + 1);
    }
    const built = await buildGateRequest(
      tx,
      ctx,
      {
        customerId,
        purpose: 'informational',
        body: reply,
        bodyRendered: true,
        dedupeKey,
        replyToInboundAt: null,
        inReplyToInboundAt: lastUnanswered.createdAt,
        toE164,
      },
      sendAt,
    );
    if (!built) return null;
    let state = textStateFor(built);
    if (state.status === 'queued' && built.toE164 === null) {
      state = { status: 'blocked', blockRule: 'contact', blockReason: 'No mobile number on file.' };
    }
    const messageId = await insertAssistantText(
      tx,
      ctx,
      { conversationId, customerId, body: reply, toE164: built.toE164, dedupeKey },
      state,
      replyAt,
    );
    if (messageId === null || state.status !== 'queued' || built.toE164 === null) return null;
    return { requeue: false as const, messageId, to: built.toE164, sender: built.sender };
  });
  if (newerPending) {
    await deps.jobs.send('fd-text', { companyId: data.companyId, conversationId }, { singletonKey: `fd-text:${conversationId}`, startAfter: FD_TEXT_DEBOUNCE_SECONDS });
  }
  if (outcome?.requeue === true) {
    await deps.jobs.send('fd-text', { companyId: data.companyId, conversationId }, { singletonKey: `fd-text:${conversationId}`, startAfter: FD_TEXT_DEBOUNCE_SECONDS });
    return;
  }
  if (outcome) {
    await sendQueuedText(deps, ctx, { messageId: outcome.messageId, to: outcome.to, body: reply, sender: outcome.sender }, 'We could not send this text.');
  }
}
