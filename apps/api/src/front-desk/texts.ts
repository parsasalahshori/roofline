import type Anthropic from '@anthropic-ai/sdk';
import {
  getConversation,
  isAgentPaused,
  listConversationTexts,
  listUnansweredInbound,
  loadCompanyFacts,
  lastTeamReplyAt,
  frontDeskTextsOn,
  insertAssistantText,
  lockRecipient,
  type TenantContext,
  type Tx,
  updateConversation,
  withTenant,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { recordTextTask } from '../agents/front-desk-tasks.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { buildGateRequest } from '../messaging/gate-request.ts';
import { sendQueuedText, textStateFor } from '../messaging/outbound.ts';
import { createEngine } from './engine.ts';
import type { Engine, ToolHandlers } from './engine-types.ts';
import { buildCompanyBlock } from './prompt.ts';
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
export async function queueFrontDeskText(tx: Tx, message: InboundMessageRef, opts?: QueueFrontDeskTextOpts): Promise<void> {
  if (opts?.consumed === true || opts?.jobs === undefined) return;
  if (await isAgentPaused(tx, { companyId: message.companyId, userId: null, role: 'system', canApproveSpend: false }, 'front_desk')) return;
  await opts.jobs.send(
    'fd-text',
    { companyId: message.companyId, conversationId: message.conversationId },
    { singletonKey: `fd-text:${message.conversationId}`, startAfter: FD_TEXT_DEBOUNCE_SECONDS },
  );
}

/** No real tool handlers yet; the engine offers only TEXT_CHANNEL_TOOLS on the sms channel. */
// TODO(Task 7/8): real tool handlers
const TEXT_TOOL_HANDLERS: ToolHandlers = {};

const TEAM_QUIET_MS = 2 * 60 * 60 * 1000;
const HISTORY_TEXTS = 20;
const MAX_REPLY_CHARS = 306; // two 153-character segments

function systemCtx(companyId: string): TenantContext {
  return { companyId, userId: null, role: 'system', canApproveSpend: false };
}

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
    if (!conversation || conversation.status !== 'active' || conversation.handledBy === 'team') return null;
    if (!(await frontDeskTextsOn(tx, ctx))) return null;
    const unanswered = await listUnansweredInbound(tx, ctx, conversationId);
    if (unanswered.length === 0) return null;
    const teamAt = await lastTeamReplyAt(tx, ctx, conversationId);
    if (teamAt && now.getTime() - teamAt.getTime() < TEAM_QUIET_MS) return null;

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
      startedAt: now,
    });
    state.customerId = conversation.customerId;
    const firstUnanswered = unanswered[0]!;
    const earlier = await listConversationTexts(tx, ctx, conversationId, HISTORY_TEXTS);
    for (const text of earlier) {
      if (text.createdAt.getTime() >= firstUnanswered.createdAt.getTime()) continue;
      if (text.direction === 'in') appendUser(state, text.body);
      else if (text.assistant) {
        appendAssistant(state, [{ type: 'text', text: text.body }] as unknown as Anthropic.ContentBlock[]);
      }
    }
    return {
      state,
      customerId: conversation.customerId,
      callerText: unanswered.map((u) => u.body).join('\n'),
      lastUnanswered: unanswered[unanswered.length - 1]!,
    };
  });
  if (!prepared) return;

  const { state, callerText, lastUnanswered } = prepared;
  // TODO(Task 8): when the booking-confirm helper exists, call it here for 'C' / 'confirm' instead of the engine.
  // Until then 'C' / 'confirm' is a normal text for the engine.
  const active = engine ?? createEngine(deps, TEXT_TOOL_HANDLERS);
  const said: string[] = [];
  let handoff = false;
  let spam = false;
  for await (const event of active.turn(state, callerText, new AbortController().signal)) {
    if (event.type === 'say') said.push(event.text);
    else if (event.type === 'handoff') handoff = true;
    else if (event.type === 'end' && event.reason === 'spam') spam = true;
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
  // TODO(Task 7): create-or-link the customer for unknown texters
  if (customerId === null) return;

  const dedupeKey = `fd-text:${lastUnanswered.id}`;
  const sendAt = deps.clock.now();
  const outcome = await withTenant(deps.pools, ctx, async (tx) => {
    await lockRecipient(tx, ctx, customerId);
    // A text that arrives mid-turn would otherwise look answered: the reply's createdAt is later than that text.
    const fresh = await listUnansweredInbound(tx, ctx, conversationId);
    const freshLast = fresh[fresh.length - 1];
    if (freshLast === undefined) return null;
    if (freshLast.id !== lastUnanswered.id) return { requeue: true as const };
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
      sendAt,
    );
    if (messageId === null || state.status !== 'queued' || built.toE164 === null) return null;
    return { requeue: false as const, messageId, to: built.toE164, sender: built.sender };
  });
  if (outcome?.requeue === true) {
    await deps.jobs.send('fd-text', { companyId: data.companyId, conversationId }, { singletonKey: `fd-text:${conversationId}`, startAfter: FD_TEXT_DEBOUNCE_SECONDS });
    return;
  }
  if (outcome) {
    await sendQueuedText(deps, ctx, { messageId: outcome.messageId, to: outcome.to, body: reply, sender: outcome.sender }, 'We could not send this text.');
    // A1 Task 4: one live task per conversation per local day. The engine events carry no booking results, so bookings is 0.
    try {
      await withTenant(deps.pools, ctx, async (tx) => {
        const { timezone } = await loadCompanyFacts(tx, ctx);
        await recordTextTask(tx, ctx, { conversationId, customerId, replies: 1, bookings: 0 }, sendAt, timezone);
      });
    } catch {
      console.error(`fd live task failed conversation=${conversationId} company=${data.companyId}`);
    }
  }
}
