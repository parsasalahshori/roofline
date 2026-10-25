import {
  insertDirectText,
  isEmailOptedOut,
  lockRecipient,
  orderCustomerFacts,
  textingCompanyFacts,
  type TenantContext,
  withTenant,
} from '@roofline/db';
import { renderStageText, type OrderEvent, type OrderStageTemplate } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { buildGateRequest } from '../messaging/gate-request.ts';
import { sendQueuedText, textStateFor } from '../messaging/outbound.ts';

/*
 * Telling the customer about an order move. The text goes through the same send gate as every other text (messaging/
 * gate-request.ts + @roofline/send-gate): it is informational, so it needs the customer's texting consent (express,
 * attested or written; a web form never gives it: Ruling BF), no do-not-contact and no STOP, a mobile number, and it waits
 * out quiet hours. A customer the gate refuses is recorded 'skipped-no-consent' and nothing is sent. The email goes only to
 * an address on file that has not opted out. Neither failure undoes the move: the result is written on the event.
 */

const SENDING_FAILED = 'We could not send this text.';

/** "Tue, Nov 3" for a 'YYYY-MM-DD' date; null for none. */
export function plannedDateText(ymd: string | null): string | null {
  if (ymd === null) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
}

type Notified = NonNullable<OrderEvent['notified']>;

/** Sends the stage's message by text and email as the settings and the customer allow; answers what happened to each. */
export async function notifyOrderMove(
  deps: AppDeps,
  ctx: TenantContext,
  move: { orderId: string; eventId: string; customerId: string; plannedFor: string | null; template: OrderStageTemplate | undefined },
): Promise<Notified> {
  const { template } = move;
  if (template === undefined || !template.enabled) return { sms: 'off', email: 'off' };
  const now = deps.clock.now();
  const prepared = await withTenant(deps.pools, ctx, async (tx) => {
    const company = await textingCompanyFacts(tx, ctx);
    const customer = await orderCustomerFacts(tx, ctx, move.customerId);
    if (!company || !customer) return null;
    const values = { first: customer.firstName, date: plannedDateText(move.plannedFor), company: company.name };
    return { customer, values, companyName: company.name };
  });
  if (prepared === null) return { sms: 'off', email: 'off' };
  const render = (text: string) => renderStageText(text, prepared.values);
  return { sms: await sendSms(deps, ctx, move, render(template.sms), now), email: await sendEmail(deps, ctx, move.customerId, prepared.customer, render(template.emailSubject), render(template.emailBody)) };
}

async function sendSms(
  deps: AppDeps,
  ctx: TenantContext,
  move: { orderId: string; eventId: string; customerId: string },
  body: string,
  now: Date,
): Promise<Notified['sms']> {
  if (body.trim() === '') return 'off';
  const dedupeKey = `bo-order:${move.orderId}:${move.eventId}`;
  try {
    const row = await withTenant(deps.pools, ctx, async (tx) => {
      await lockRecipient(tx, ctx, move.customerId);
      const built = await buildGateRequest(tx, ctx, { customerId: move.customerId, purpose: 'informational', body, bodyRendered: true, dedupeKey, replyToInboundAt: null }, now);
      if (!built) return { result: 'off' as const };
      // No mobile number on file: there is nobody to text, which is not a refusal, so nothing is recorded.
      if (built.toE164 === null) return { result: 'off' as const };
      const state = textStateFor(built);
      const id = await insertDirectText(tx, ctx, { customerId: move.customerId, body, toE164: built.toE164, dedupeKey }, state, now);
      return { result: 'row' as const, id, state, to: built.toE164, sender: built.sender };
    });
    if (row.result === 'off') return 'off';
    switch (row.state.status) {
      case 'blocked':
        // Consent, do-not-contact, STOP, archived or a number that cannot get texts: the customer is not texted.
        return row.state.blockRule === 'consent' || row.state.blockRule === 'contact' ? 'skipped-no-consent' : 'failed';
      case 'failed':
        return 'failed';
      case 'scheduled':
        // Quiet hours: the dispatcher sends it at the next allowed time.
        return 'sent';
      case 'queued':
        return (await sendQueuedText(deps, ctx, { messageId: row.id, to: row.to, body, sender: row.sender }, SENDING_FAILED)) === 'sent' ? 'sent' : 'failed';
    }
  } catch (err) {
    deps.logError?.(err, 'backoffice-order-sms');
    return 'failed';
  }
}

async function sendEmail(
  deps: AppDeps,
  ctx: TenantContext,
  customerId: string,
  customer: { emails: string[]; doNotContact: boolean },
  subject: string,
  text: string,
): Promise<Notified['email']> {
  const to = customer.emails[0]?.trim();
  if (to === undefined || to === '' || customer.doNotContact || subject.trim() === '' || text.trim() === '') return 'off';
  try {
    if (await withTenant(deps.pools, ctx, (tx) => isEmailOptedOut(tx, ctx, to))) return 'off';
    await deps.mailer.send({ to, subject, text });
    return 'sent';
  } catch (err) {
    deps.logError?.(err, `backoffice-order-email:${customerId}`);
    return 'failed';
  }
}
