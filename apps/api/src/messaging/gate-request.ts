import {
  type CustomerPhone,
  isOptedOut,
  type TenantContext,
  textHistory,
  textingCompanyFacts,
  textingRecipientFacts,
  type Tx,
} from '@roofline/db';
import type { GateRequest } from '@roofline/send-gate';
import { type MessagePurpose, renderBody } from '@roofline/shared';

/*
 * Turns "text this customer this message" into everything the send gate (`decide`, in
 * @roofline/send-gate) needs, read fresh from the company's tables. The batch step asks it once per
 * customer, and the dispatcher asks again when a waiting text comes due, so whatever changed in
 * between (a STOP, do-not-contact, consent, billing, the weekly cap) is what the gate sees.
 */

/** How far back the weekly marketing cap looks. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type GateRequestInput = {
  customerId: string;
  purpose: MessagePurpose;
  /** The template, with `{first_name}` and `{company}` still in it (or the finished text, with `bodyRendered`). */
  body: string;
  /**
   * True when `body` is already the text as it goes out (a waiting text, rendered when it was
   * scheduled), so it is not rendered a second time.
   */
  bodyRendered?: boolean;
  /** For example `storm:elm:<customer id>`; null when the text has none. */
  dedupeKey: string | null;
  /** When the customer's text this one answers arrived, if it is a reply. */
  replyToInboundAt: Date | null;
};

export type BuiltGateRequest = {
  req: GateRequest;
  /** The number the text would go to, the same as `req.recipient.phoneE164`. */
  toE164: string | null;
};

/** The customer's primary number, else their first, else null. */
function textingNumber(phones: readonly CustomerPhone[]): string | null {
  const usable = phones.filter((p) => typeof p?.e164 === 'string' && p.e164.trim() !== '');
  return (usable.find((p) => p.primary === true) ?? usable[0])?.e164 ?? null;
}

/**
 * The gate request for one text to one customer of the context's company, at `now`:
 * - **company:** name, zone and billing status, the registration's campaign status (`none` without
 *   a registration) and the weekly cap from the settings;
 * - **recipient:** the primary number (else the first, else none), consent, do-not-contact, whether
 *   that number is on the opt-out list, and the zone and state of their most recently updated home
 *   (null without one: the gate then uses the company's zone and the standard hours);
 * - **message:** the body rendered with their first name and the company name, as it would be sent
 *   (or as given, when it is already rendered);
 * - **history:** whether a text with this dedupe key already went out (or is going out) from any
 *   step, and when their marketing texts went out in the last 7 days.
 *
 * Returns null when the customer is not one of this company's.
 */
export async function buildGateRequest(
  tx: Tx,
  ctx: TenantContext,
  input: GateRequestInput,
  now: Date,
): Promise<BuiltGateRequest | null> {
  const company = await textingCompanyFacts(tx, ctx);
  // The context's own company always exists; not seeing it is a broken setup, not a customer issue.
  if (!company) throw new Error('The company for this text could not be found.');
  const recipient = await textingRecipientFacts(tx, ctx, input.customerId);
  if (!recipient) return null;

  const phoneE164 = textingNumber(recipient.phones);
  const optedOut = phoneE164 !== null && (await isOptedOut(tx, ctx, phoneE164));
  const history = await textHistory(tx, ctx, {
    customerId: input.customerId,
    dedupeKey: input.dedupeKey,
    since: new Date(now.getTime() - WEEK_MS),
  });
  const body =
    input.bodyRendered === true
      ? input.body
      : renderBody(input.body, {
          ...(recipient.firstName !== null && { first_name: recipient.firstName }),
          company: company.name,
        });

  return {
    toE164: phoneE164,
    req: {
      now,
      company: {
        name: company.name,
        timezone: company.timezone,
        status: company.status,
        campaignStatus: company.campaignStatus,
        marketingCapPer7d: company.marketingCapPer7d,
      },
      recipient: {
        phoneE164,
        consent: recipient.consent,
        doNotContact: recipient.doNotContact,
        optedOut,
        timezone: recipient.timezone,
        state: recipient.state,
      },
      message: { purpose: input.purpose, body, dedupeKey: input.dedupeKey, replyToInboundAt: input.replyToInboundAt },
      history,
    },
  };
}
