import {
  companyContact,
  findOrCreateCallerCustomer,
  insertTextBackMessage,
  lockRecipient,
  missedCallTextBackOn,
  recordCallConsent,
  setCallTextBackMessage,
  type TenantContext,
  textedBackWithin24h,
  withTenant,
} from '@roofline/db';
import { cachedLineType, saveLineType } from '@roofline/db/system';
import { renderBody, shouldTextBack } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { buildGateRequest } from '../messaging/gate-request.ts';
import { sendQueuedText, textStateFor } from '../messaging/outbound.ts';

/** D1 Task 13: the missed-call text-back. Sends only through the F1 send gate, as an informational text. */
export type TextBackInput = {
  callId: string;
  callSid: string;
  fromE164: string;
  /** The company number that was called. */
  toE164: string;
  /** The conversation the call opened, or null when the caller never reached the assistant. */
  conversationId: string | null;
  customerId: string | null;
  status: 'failed' | 'completed' | 'no_answer' | 'busy';
  callerTurns: number;
  secondsInCall: number;
  spam: boolean;
};
/** sent: went to Twilio; scheduled: the gate held it (quiet hours); blocked: the gate refused; skipped: shouldTextBack said no (or no setting/number). */
export type TextBackResult = 'sent' | 'scheduled' | 'blocked' | 'skipped';

/** The text-back copy; {company} is the company name. */
export const TEXT_BACK_BODY = 'Hi, this is {company}. Sorry we missed your call. Reply here and we will help you.';

export async function maybeTextBack(deps: AppDeps, ctx: TenantContext, input: TextBackInput): Promise<TextBackResult> {
  const now = deps.clock.now();

  const gates = await withTenant(deps.pools, ctx, async (tx) => ({
    enabled: await missedCallTextBackOn(tx, ctx),
    already: await textedBackWithin24h(tx, ctx, input.fromE164, now),
  }));
  if (!gates.enabled || gates.already) return 'skipped';

  let lineType = await cachedLineType(deps.pools.system, input.fromE164, now);
  if (lineType === null) {
    lineType = await deps.lineLookup.lineType(input.fromE164);
    if (lineType !== 'unknown') await saveLineType(deps.pools.system, input.fromE164, lineType, now);
  }

  const wanted = shouldTextBack({
    callerTurns: input.callerTurns,
    secondsInCall: input.secondsInCall,
    status: input.status,
    lineType,
    spam: input.spam,
    textedBackLast24h: gates.already,
    enabled: gates.enabled,
  });
  if (!wanted) return 'skipped';

  const dedupeKey = `fd-textback:${input.callId}`;
  const outcome = await withTenant(deps.pools, ctx, async (tx) => {
    const customerId = input.customerId ?? (await findOrCreateCallerCustomer(tx, ctx, input.fromE164, now));
    if (customerId === null) return null;
    const company = await companyContact(tx, ctx);
    const body = renderBody(TEXT_BACK_BODY, { company: company?.name ?? '' });
    await lockRecipient(tx, ctx, customerId);
    await recordCallConsent(tx, ctx, customerId, now);
    const built = await buildGateRequest(
      tx,
      ctx,
      { customerId, purpose: 'informational', body, bodyRendered: true, dedupeKey, replyToInboundAt: null },
      now,
    );
    if (!built) return null;
    let state = textStateFor(built);
    if (state.status === 'queued' && built.toE164 === null) {
      state = { status: 'blocked', blockRule: 'contact', blockReason: 'No mobile number on file.' };
    }
    const messageId = await insertTextBackMessage(
      tx,
      ctx,
      { conversationId: input.conversationId, customerId, body, toE164: built.toE164, dedupeKey },
      state,
      now,
    );
    if (messageId === null) return null;
    await setCallTextBackMessage(tx, ctx, input.callSid, messageId);
    return { state, messageId, body, to: built.toE164, sender: built.sender };
  });
  if (outcome === null) return 'skipped';

  switch (outcome.state.status) {
    case 'queued':
      if (outcome.to === null) return 'blocked';
      await sendQueuedText(
        deps,
        ctx,
        { messageId: outcome.messageId, to: outcome.to, body: outcome.body, sender: outcome.sender },
        'We could not send this text.',
      );
      return 'sent';
    case 'scheduled':
      return 'scheduled';
    default:
      return 'blocked';
  }
}
