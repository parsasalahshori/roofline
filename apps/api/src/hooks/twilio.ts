import express, { type Request, type Response, Router } from 'express';
import twilio from 'twilio';
import {
  companyContact,
  customersWithPhone,
  type DeliveryOutcome,
  flagPossibleOptOut,
  insertInboundText,
  lockRecipients,
  recordDeliveryOutcome,
  restoreConsentByText,
  revokeConsentByText,
  type TenantContext,
  withTenant,
} from '@roofline/db';
import { claimWebhookEvent, companyIdForNumber, releaseWebhookEvent, signingTokenFor } from '@roofline/db/system';
import { looksLikeOptOut, readInbound } from '@roofline/send-gate';
import type { AppDeps } from '../app.ts';

/*
 * Twilio's webhooks (spec 4.5, R24), mounted at /hooks/twilio ahead of the /api session gate:
 * - POST /sms     a text came in to one of a company's numbers. Stored, then STOP / HELP / START
 *                 handled, and the reply sent back as TwiML.
 * - POST /status  a delivery report for a text that went out.
 *
 * Both are form posts. Before anything is written, each one is:
 * 1. routed: the company's own number (`To` of a text that came in, `From` of a report) must be an
 *    active texting number (company_phone_numbers), else 404 with an empty body;
 * 2. authenticated: `X-Twilio-Signature` must be Twilio's signature of PUBLIC_BASE_URL + the path
 *    and the form fields, made with that company's subaccount token (else TWILIO_AUTH_TOKEN), else
 *    403. A company with no token at all is 403 too;
 * 3. deduplicated: Twilio may deliver the same webhook more than once, so each delivery is claimed
 *    in webhook_events first and a repeat does nothing (200, an empty reply). When the work for a
 *    claimed delivery fails, the claim is given back so Twilio's next try is handled.
 * The company's work then runs as app_tenant inside `withTenant` (role `system`, no user).
 */

/** Form bodies on these routes are capped at 64 KB (a text is at most 1,600 characters). */
export const FORM_BODY_LIMIT = '64kb';

/** Delivery reports that fail a text, and what the message row then says. */
export const CARRIER_FAILED = "The carrier couldn't deliver this text.";

const SMS_EVENTS = 'twilio-sms';
const STATUS_EVENTS = 'twilio-status';

const E164 = /^\+[1-9]\d{1,14}$/;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const XML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Text made safe to put inside TwiML: the five XML special characters become entities. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ENTITIES[ch]!);
}

/** A US number as people write it, (402) 555-0199; any other number as it is. */
function displayPhone(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}

/*
 * The replies. Every dynamic part (the company's name and phone) is escaped here; the fixed text
 * has no XML special characters that matter inside an element (an apostrophe is fine there).
 */
const reply = {
  stop: (company: string) =>
    `You're unsubscribed from ${escapeXml(company)} texts. No more messages will be sent. Reply START to resubscribe.`,
  help: (company: string, phone: string | null) =>
    phone === null
      ? `${escapeXml(company)}. Reply STOP to opt out.`
      : `${escapeXml(company)}: call us at ${escapeXml(displayPhone(phone))}. Reply STOP to opt out.`,
  start: (company: string) => `You're resubscribed to ${escapeXml(company)} texts. Reply STOP to opt out.`,
};

/** Answers with TwiML: one <Message> (its text already escaped), or an empty <Response/>. */
function sendTwiml(res: Response, messageXml?: string): void {
  const body = messageXml === undefined ? '<Response/>' : `<Response><Message>${messageXml}</Message></Response>`;
  res.status(200).type('text/xml').send(XML_HEAD + body);
}

/** A form field, only when it is a single string (a repeated or missing field is undefined). */
function field(req: Request, name: string): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  return typeof value === 'string' ? value : undefined;
}

const systemCtx = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

/**
 * Steps 1 and 2 (routing, then the signature), on `numberField` (the company's own number).
 * Answers 404 or 403 itself and returns null; otherwise the company's id.
 */
async function verify(deps: AppDeps, req: Request, res: Response, numberField: 'To' | 'From'): Promise<string | null> {
  const { system } = deps.pools;
  const number = field(req, numberField);
  const companyId = number !== undefined && E164.test(number) ? await companyIdForNumber(system, number) : null;
  if (companyId === null) {
    res.status(404).end();
    return null;
  }
  const token = await signingTokenFor(system, companyId, deps.config.TWILIO_AUTH_TOKEN, deps.config.ENCRYPTION_KEY);
  const signature = req.get('X-Twilio-Signature');
  const url = deps.config.PUBLIC_BASE_URL + req.originalUrl;
  if (token === null || signature === undefined || !twilio.validateRequest(token, signature, url, req.body ?? {})) {
    res.status(403).end();
    return null;
  }
  return companyId;
}

/** Step 3 and the work: claims the delivery, runs `work`, and gives the claim back if `work` throws. */
async function once<T>(deps: AppDeps, provider: string, eventId: string, work: () => Promise<T>): Promise<{ repeat: true } | { repeat: false; value: T }> {
  const { system } = deps.pools;
  if (!(await claimWebhookEvent(system, provider, eventId))) return { repeat: true };
  try {
    return { repeat: false, value: await work() };
  } catch (err) {
    try {
      await releaseWebhookEvent(system, provider, eventId);
    } catch (releaseErr) {
      deps.logError?.(releaseErr, `${provider}: releasing a failed delivery`);
    }
    throw err;
  }
}

type Inbound = { messageSid: string; from: string; to: string; body: string };

/**
 * A text that came in, for the company, in one transaction. Returns the reply (escaped), or
 * undefined for none.
 * - It is stored as received, filed under the first active customer with the sender's number.
 * - STOP: the texting locks of every customer with the number (archived ones too) are taken first,
 *   so a send deciding for one of them right now finishes first and the next one sees the STOP;
 *   then the number goes on the opt-out list and all of them are revoked (`revokeConsentByText`).
 *   With no customer, the number is still put on the list.
 * - HELP: the company's name and phone.
 * - START: under the active customers' locks, the number comes off the opt-out list and the revoked
 *   ones are back to `express` (`restoreConsentByText`). Do-not-contact stays as it is.
 * - anything else: no reply; a message that reads like an opt-out is flagged on each active
 *   customer's timeline for a person to check, and nobody is opted out.
 */
async function handleInbound(deps: AppDeps, companyId: string, text: Inbound): Promise<string | undefined> {
  const ctx = systemCtx(companyId);
  const now = deps.clock.now();
  const reading = readInbound(text.body);
  return withTenant(deps.pools, ctx, async (tx) => {
    const company = await companyContact(tx, ctx);
    if (company === null) throw new Error('The company that owns a texting number could not be read.');
    const everyone = await customersWithPhone(tx, ctx, text.from);
    const active = everyone.filter((c) => !c.archived).map((c) => c.id);
    const all = everyone.map((c) => c.id);

    if (reading.kind === 'stop') await lockRecipients(tx, ctx, all);
    if (reading.kind === 'start') await lockRecipients(tx, ctx, active);

    const messageId = await insertInboundText(
      tx,
      ctx,
      { customerId: active[0] ?? null, body: text.body, fromE164: text.from, toE164: text.to, providerSid: text.messageSid },
      now,
    );

    switch (reading.kind) {
      case 'stop':
        await revokeConsentByText(tx, ctx, { phoneE164: text.from, keyword: reading.keyword, customerIds: all, messageId }, now);
        return reply.stop(company.name);
      case 'help':
        return reply.help(company.name, company.phoneE164);
      case 'start':
        await restoreConsentByText(tx, ctx, { phoneE164: text.from, customerIds: active, messageId }, now);
        return reply.start(company.name);
      case 'other':
        if (looksLikeOptOut(text.body)) await flagPossibleOptOut(tx, ctx, active, messageId, now);
        return undefined;
    }
  });
}

/** What a delivery report's MessageStatus does to the text; null for the ones that change nothing. */
function outcomeOf(status: string): DeliveryOutcome | null {
  if (status === 'delivered') return { status: 'delivered' };
  if (status === 'failed' || status === 'undelivered') return { status: 'failed', reason: CARRIER_FAILED };
  return null;
}

export function twilioHooks(deps: AppDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));

  router.post('/sms', async (req, res) => {
    const companyId = await verify(deps, req, res, 'To');
    if (companyId === null) return;
    const messageSid = field(req, 'MessageSid');
    const from = field(req, 'From');
    if (!messageSid || !from) {
      res.status(400).end();
      return;
    }
    const text: Inbound = { messageSid, from, to: field(req, 'To')!, body: field(req, 'Body') ?? '' };
    const done = await once(deps, SMS_EVENTS, messageSid, () => handleInbound(deps, companyId, text));
    sendTwiml(res, done.repeat ? undefined : done.value);
  });

  /**
   * `delivered` → delivered; `failed` / `undelivered` → failed, not retryable, with the carrier
   * reason; both only from `sent` (`recordDeliveryOutcome`), so nothing goes backwards. Any other
   * status (queued, sending, sent, ...) and an id that is no text of the company's: 200, nothing done.
   */
  router.post('/status', async (req, res) => {
    const companyId = await verify(deps, req, res, 'From');
    if (companyId === null) return;
    const messageSid = field(req, 'MessageSid');
    const messageStatus = field(req, 'MessageStatus');
    if (!messageSid || !messageStatus) {
      res.status(400).end();
      return;
    }
    const outcome = outcomeOf(messageStatus);
    if (outcome !== null) {
      const ctx = systemCtx(companyId);
      await once(deps, STATUS_EVENTS, `${messageSid}:${messageStatus}`, () =>
        withTenant(deps.pools, ctx, (tx) => recordDeliveryOutcome(tx, ctx, messageSid, outcome, deps.clock.now())),
      );
    }
    res.status(200).end();
  });

  return router;
}
