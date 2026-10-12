import type { ConversationOutcome } from '@roofline/shared';
import {
  addActivity,
  closeCallAfterCall,
  countCallerTurns,
  getConversation,
  listTurns,
  loadBookingActions,
  loadCallForAfterCall,
  loadCompanyFacts,
  recordUsage,
  type TenantContext,
  updateCall,
  updateConversation,
  withTenant,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { recordCallTask } from '../agents/front-desk-tasks.ts';
import { buildCompanyBlock } from './prompt.ts';
import { maybeTextBack } from './text-back.ts';

/*
 * D1 Task 13: everything that happens after a call. Idempotent: the usage event is unique on the call, the
 * summary step is skipped once the conversation has a summary, and the text-back checks its own state.
 * Never logs transcript text, phone numbers or recording URLs.
 */

/** Tool name to the outcome it proves. */
const ACTION_OUTCOMES: Record<string, ConversationOutcome> = {
  book_inspection: 'booked',
  move_inspection: 'moved',
  confirm_appointment: 'confirmed',
  take_claim_details: 'claim',
  transfer_to_person: 'transferred',
  take_message: 'message',
};

/** Actions win over the model: booked > moved > confirmed > claim > transferred > message > the model's outcome. */
export function pickOutcome(actions: string[], transferred: boolean, modelOutcome: ConversationOutcome): ConversationOutcome {
  const seen = new Set<ConversationOutcome>();
  for (const a of actions) {
    const o = ACTION_OUTCOMES[a];
    if (o !== undefined) seen.add(o);
  }
  if (transferred) seen.add('transferred');
  for (const o of ['booked', 'moved', 'confirmed', 'claim', 'transferred', 'message'] as const) {
    if (seen.has(o)) return o;
  }
  return modelOutcome;
}

const PLAIN: Record<string, string> = {
  booked: 'The caller booked an inspection.',
  moved: 'The caller moved an inspection.',
  confirmed: 'The caller confirmed an inspection.',
  claim: 'The caller reported an insurance claim.',
  transferred: 'The call was transferred to a person.',
  message: 'The caller left a message for the team.',
};

function plainSummary(outcome: ConversationOutcome): string {
  return PLAIN[outcome] ?? 'The caller spoke with the assistant.';
}

function firstSentence(text: string): string {
  const m = /^[^.!?]*[.!?]?/.exec(text.trim());
  const s = (m?.[0] ?? text).trim();
  return (s === '' ? text.trim() : s).slice(0, 200);
}

/** One live Front Desk task per call. A failure here never breaks the rest of the after-call work. */
async function recordLiveTask(deps: AppDeps, ctx: TenantContext, input: Parameters<typeof recordCallTask>[2], now: Date): Promise<void> {
  try {
    await withTenant(deps.pools, ctx, (tx) => recordCallTask(tx, ctx, input, now));
  } catch {
    console.error(`fd live task failed call=${input.callId}`);
  }
}

export async function runAfterCall(deps: AppDeps, data: { companyId: string; callSid?: string; conversationId?: string }): Promise<void> {
  const callSid = data.callSid;
  if (callSid === undefined) return;
  const ctx: TenantContext = { companyId: data.companyId, userId: null, role: 'system', canApproveSpend: false };
  const now = deps.clock.now();

  const prep = await withTenant(deps.pools, ctx, async (tx) => {
    const call = await loadCallForAfterCall(tx, ctx, callSid);
    if (!call) return null;
    const testCaller = deps.config.TWILIO_TEST_CALLER_NUMBER;
    if (call.conversationId === null && testCaller !== undefined && call.fromE164 === testCaller) return null;

    if (call.aiSeconds > 0) {
      const minutes = Math.ceil(call.aiSeconds / 60);
      await recordUsage(tx, ctx, {
        kind: 'ai_call_minute',
        quantity: minutes,
        unitCostCents: null,
        refType: 'call',
        refId: call.id,
        description: 'AI call minutes',
        at: now,
      });
      await closeCallAfterCall(tx, ctx, callSid, { billedMinutes: minutes });
    }
    if (call.spamReason !== null) return { call, spam: true as const };

    let conversation = null;
    let transcript = '';
    let actions: string[] = [];
    let callerTurns = 0;
    let companyBlock = '';
    if (call.conversationId !== null) {
      conversation = await getConversation(tx, ctx, call.conversationId);
      actions = await loadBookingActions(tx, ctx, call.conversationId);
      callerTurns = await countCallerTurns(tx, ctx, call.conversationId);
      if (conversation && conversation.summary === null) {
        if (call.transcriptStored) {
          const turns = await listTurns(tx, ctx, call.conversationId);
          transcript = turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
        }
        const facts = await loadCompanyFacts(tx, ctx);
        companyBlock = buildCompanyBlock({
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
      }
    }
    return { call, spam: false as const, conversation, transcript, actions, callerTurns, companyBlock };
  });
  if (!prep) return;
  const { call } = prep;
  const secondsInCall =
    call.aiSeconds > 0
      ? call.aiSeconds
      : Math.max(0, Math.round(((call.endedAt ?? now).getTime() - call.startedAt.getTime()) / 1000));
  if (prep.spam) {
    // Screening rejected the call before Front Desk ran: no task. A spam call the AI had started still gets one.
    if (call.status === 'rejected' && call.aiStartedAt === null) return;
    await recordLiveTask(deps, ctx, { callId: call.id, conversationId: call.conversationId, customerId: null, seconds: secondsInCall, bookings: 0, spam: true, outcome: null }, now);
    return;
  }

  const transferred = call.status === 'transferred' || call.transferResult === 'answered';
  const { conversation, actions } = prep;
  let pickedOutcome: ConversationOutcome | null = conversation?.outcome ?? null;

  if (conversation && conversation.summary === null && call.conversationId !== null) {
    const conversationId = call.conversationId;
    let summary: string;
    let modelOutcome: ConversationOutcome = 'other';
    let followUps: string[] = [];
    try {
      const out = await deps.llm.summarize({ companyBlock: prep.companyBlock, transcript: prep.transcript, actions });
      summary = out.summary.trim();
      modelOutcome = out.outcome;
      followUps = out.followUps;
      if (summary === '') throw new Error('empty summary');
    } catch {
      console.error(`after-call summary fell back call=${call.id} company=${data.companyId}`);
      summary = '';
    }
    const outcome = pickOutcome(actions, transferred, modelOutcome);
    pickedOutcome = outcome;
    if (summary === '') summary = plainSummary(outcome);

    await withTenant(deps.pools, ctx, async (tx) => {
      const fresh = await getConversation(tx, ctx, conversationId);
      if (!fresh || fresh.summary !== null) return;
      await updateConversation(tx, ctx, conversationId, { status: 'ended', outcome, summary });
      if (call.status === 'ringing' || call.status === 'ai') {
        await updateCall(tx, ctx, callSid, { status: 'ended', ...(call.endedAt === null && { endedAt: now }) });
      }
      if (fresh.customerId !== null) {
        await addActivity(tx, ctx, {
          subjectType: 'customer',
          subjectId: fresh.customerId,
          kind: fresh.channel === 'sms' ? 'text_conversation' : 'call',
          summary: firstSentence(summary),
          data: { summary, outcome, callId: call.id, conversationId, followUps },
          at: now,
          actorAgent: 'front_desk',
        });
      }
    });
  } else if (call.status === 'ringing' || call.status === 'ai') {
    await withTenant(deps.pools, ctx, (tx) =>
      updateCall(tx, ctx, callSid, { status: 'ended', ...(call.endedAt === null && { endedAt: now }) }),
    );
  }

  // A paused or voicemail call the AI never answered makes no task; a call screening rejected as spam before Front Desk ran makes none either.
  if (call.conversationId !== null || call.aiStartedAt !== null || call.aiSeconds > 0) {
    await recordLiveTask(
      deps,
      ctx,
      {
        callId: call.id,
        conversationId: call.conversationId,
        customerId: conversation?.customerId ?? null,
        seconds: secondsInCall,
        bookings: actions.filter((a) => a === 'book_inspection' || a === 'move_inspection').length,
        spam: false,
        outcome: pickedOutcome,
      },
      now,
    );
  }

  if (transferred || call.status === 'rejected') return;
  await maybeTextBack(deps, ctx, {
    callId: call.id,
    callSid,
    fromE164: call.fromE164,
    toE164: call.toE164,
    conversationId: call.conversationId,
    customerId: conversation?.customerId ?? null,
    status: call.status === 'failed' ? 'failed' : 'completed',
    callerTurns: prep.callerTurns,
    secondsInCall,
    spam: false,
  });
}
