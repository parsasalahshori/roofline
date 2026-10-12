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
  recordCallMinutes,
  type TenantContext,
  type Tx,
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

/** A call is finished once it is in one of these; mid-call (ringing, ai, ringing_team) the job does nothing. */
const FINISHED = new Set<string>(['ended', 'transferred', 'failed', 'rejected']);

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

/** The company block the summary prompt carries (the same for voice and SMS). */
async function loadCompanyBlock(tx: Tx, ctx: TenantContext): Promise<string> {
  const facts = await loadCompanyFacts(tx, ctx);
  return buildCompanyBlock({
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

/** The model's summary, or '' when it fails (the caller falls back to the plain sentence). */
async function summarizeOrEmpty(
  deps: AppDeps,
  input: { companyBlock: string; transcript: string; actions: string[] },
  logRef: string,
): Promise<{ summary: string; modelOutcome: ConversationOutcome; followUps: string[] }> {
  try {
    const out = await deps.llm.summarize(input);
    const summary = out.summary.trim();
    if (summary === '') throw new Error('empty summary');
    return { summary, modelOutcome: out.outcome, followUps: out.followUps };
  } catch {
    console.error(`after-call summary fell back ${logRef}`);
    return { summary: '', modelOutcome: 'other', followUps: [] };
  }
}

/** Outcomes that leave the conversation unread so the inbox shows it as needing attention. */
const ATTENTION_OUTCOMES = new Set<ConversationOutcome>(['booked', 'message', 'claim']);

/** SMS threads have no call: summarize the idle conversation once, end it, log one activity. No usage, no text-back. */
async function runSmsAfterCall(deps: AppDeps, ctx: TenantContext, conversationId: string): Promise<void> {
  const now = deps.clock.now();
  const prep = await withTenant(deps.pools, ctx, async (tx) => {
    const conversation = await getConversation(tx, ctx, conversationId);
    if (!conversation || conversation.channel !== 'sms' || conversation.summary !== null) return null;
    const turns = await listTurns(tx, ctx, conversationId);
    const transcript = turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    const actions = await loadBookingActions(tx, ctx, conversationId);
    return { transcript, actions, companyBlock: await loadCompanyBlock(tx, ctx) };
  });
  if (!prep) return;
  const out = await summarizeOrEmpty(deps, prep, `conversation=${conversationId} company=${ctx.companyId}`);
  const outcome = pickOutcome(prep.actions, false, out.modelOutcome);
  const summary = out.summary === '' ? plainSummary(outcome) : out.summary;
  await withTenant(deps.pools, ctx, async (tx) => {
    const fresh = await getConversation(tx, ctx, conversationId);
    if (!fresh || fresh.summary !== null) return;
    await updateConversation(tx, ctx, conversationId, { status: 'ended', outcome, summary });
    if (fresh.customerId !== null) {
      await addActivity(tx, ctx, {
        subjectType: 'customer',
        subjectId: fresh.customerId,
        kind: 'text_conversation',
        summary: firstSentence(summary),
        data: { summary, outcome, conversationId, followUps: out.followUps },
        at: now,
        actorAgent: 'front_desk',
      });
    }
  });
}

export async function runAfterCall(
  deps: AppDeps,
  data: { companyId: string; callSid?: string; conversationId?: string; swept?: boolean },
): Promise<void> {
  const callSid = data.callSid;
  const ctx: TenantContext = { companyId: data.companyId, userId: null, role: 'system', canApproveSpend: false };
  if (callSid === undefined) {
    if (data.conversationId !== undefined) await runSmsAfterCall(deps, ctx, data.conversationId);
    return;
  }
  const now = deps.clock.now();

  const prep = await withTenant(deps.pools, ctx, async (tx) => {
    const call = await loadCallForAfterCall(tx, ctx, callSid);
    if (!call) return null;
    const testCaller = deps.config.TWILIO_TEST_CALLER_NUMBER;
    if (call.conversationId === null && testCaller !== undefined && call.fromE164 === testCaller) return null;
    if (!FINISHED.has(call.status)) return null;

    if (call.aiSeconds > 0) {
      const minutes = Math.ceil(call.aiSeconds / 60);
      const billed = await recordCallMinutes(tx, ctx, { callId: call.id, minutes, description: 'AI call minutes', at: now });
      await closeCallAfterCall(tx, ctx, callSid, { billedMinutes: billed });
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
        companyBlock = await loadCompanyBlock(tx, ctx);
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
    const out = await summarizeOrEmpty(deps, { companyBlock: prep.companyBlock, transcript: prep.transcript, actions }, `call=${call.id} company=${data.companyId}`);
    const followUps = out.followUps;
    let summary = out.summary;
    const modelOutcome = out.modelOutcome;
    const outcome = pickOutcome(actions, transferred, modelOutcome);
    pickedOutcome = outcome;
    if (summary === '') summary = plainSummary(outcome);

    await withTenant(deps.pools, ctx, async (tx) => {
      const fresh = await getConversation(tx, ctx, conversationId);
      if (!fresh || fresh.summary !== null) return;
      const unansweredTransfer = outcome === 'transferred' && !transferred;
      const needsAttention = ATTENTION_OUTCOMES.has(outcome) || unansweredTransfer;
      await updateConversation(tx, ctx, conversationId, {
        status: 'ended',
        outcome,
        summary,
        ...(needsAttention ? { unreadAtLeast: 1 } : {}),
      });
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

  // A call the fd-health sweep ended (data.swept) is never texted back: its caller may still be on the line (CV#3).
  if (transferred || call.status === 'rejected' || data.swept === true) return;
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
