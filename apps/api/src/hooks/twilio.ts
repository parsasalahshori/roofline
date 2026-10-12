import express, { type Request, type Response, Router } from 'express';
import twilio from 'twilio';
import {
  attachInboundToConversation,
  companyContact,
  customersWithPhone,
  type DeliveryOutcome,
  flagPossibleOptOut,
  frontDeskTextsOn,
  insertInboundText,
  lockDeliverySid,
  lockRecipients,
  recordDeliveryOutcome,
  restoreConsentByText,
  revokeConsentByText,
  saveEarlyDeliveryReport,
  type TenantContext,
  withTenant,
} from '@roofline/db';
import { companyIdForMessagingService, companyIdForNumber, signingTokenFor } from '@roofline/db/system';
import { type InboundReading, looksLikeOptOut, readInbound } from '@roofline/send-gate';
import { onClaimsReply } from '../agents/claims/replies.ts';
import type { AppDeps } from '../app.ts';
import { queueFrontDeskText } from '../front-desk/texts.ts';
import { onStormReply } from '../storm/replies.ts';

/*
 * Twilio's webhooks (spec 4.5, R24), mounted at /hooks/twilio ahead of the /api session gate:
 * - POST /sms     a text came in to one of a company's numbers, from a person or a short code. Stored,
 *                 then STOP / HELP / START handled (Twilio's own OptOutType, when sent, decides
 *                 STOP / START / HELP instead of the body), and the reply sent back as TwiML.
 * - POST /status  a delivery report for a text that went out.
 *
 * Both are form posts. Before anything is written, each one is:
 * 1. routed: the company's own number (`To` of a text that came in, `From` of a report) must be a
 *    texting number (company_phone_numbers), else 404 with an empty body. A text that came in and a
 *    report both route whatever the number's status, so a STOP still opts out and a report for a
 *    released number is still applied. A report with no usable `From` (none, or not E.164) routes by
 *    its `MessagingServiceSid` instead (texting_registrations);
 * 2. authenticated: `X-Twilio-Signature` must be Twilio's signature of PUBLIC_BASE_URL + the path
 *    and the form fields, made with that company's subaccount token (else TWILIO_AUTH_TOKEN), else
 *    403. A company with no token at all is 403 too;
 * 3. checked for shape: MessageSid (and SmsSid, when sent) must be Twilio's id format, SM or MM and
 *    32 lowercase hex digits, and the numbers must be E.164 (a text's `From` may also be a short
 *    code, 3 to 8 digits), else 400 with an empty body. This is not
 *    tidiness: the signature joins the sorted names and values with no separator, so a signed
 *    request re-split ("SM...NumMedia0" as the MessageSid, NumMedia left out) still verifies, and
 *    without this check it would pass the dedupe below as a new message (a replayed START could undo
 *    a later STOP);
 * 4. deduplicated: Twilio may deliver the same webhook more than once. /sms dedupes inside the
 *    tenant transaction: the inbound message insert (unique on company and MessageSid) is the claim,
 *    so a repeat does nothing and answers an empty reply, and a failure rolls everything back and
 *    answers 500 so Twilio's retry is handled. /status is not claimed in webhook_events: its writes
 *    are idempotent (a text only moves from `sent`, and an early report is stored once).
 * The company's work then runs as app_tenant inside `withTenant` (role `system`, no user).
 *
 * /status is routed by its `From` (the company's number, active or not), else by its
 * `MessagingServiceSid` (the company's texting registration). A delivery report can reach us before
 * the send that made the text is saved. Such a report (its SID is no text of the company's yet) is
 * kept in early_delivery_reports, and applied when the send is saved (markTextSent). The SID's
 * advisory transaction lock makes the two take turns, so a report is never stored after the save
 * already looked for it.
 */

/** Form bodies on these routes are capped at 64 KB (a text is at most 1,600 characters). */
export const FORM_BODY_LIMIT = '64kb';

/** Delivery reports that fail a text, and what the message row then says. */
export const CARRIER_FAILED = "The carrier couldn't deliver this text.";

export const E164 = /^\+[1-9]\d{1,14}$/;
/** Twilio's id of a messaging service: MG and 32 lowercase hex digits. */
const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/;
/** A short code, the 3 to 8 digit sender of a carrier message. */
const SHORT_CODE = /^\d{3,8}$/;
/** Twilio's id of a text: SM (or MM for one with media) and 32 lowercase hex digits. */
const MESSAGE_SID = /^(SM|MM)[0-9a-f]{32}$/;

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const XML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * Whether a code point may appear in an XML 1.0 document at all (the `Char` production): tab,
 * newline, carriage return, and everything from U+0020 up except the surrogates, U+FFFE and U+FFFF.
 */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/**
 * Text made safe to put inside TwiML: characters XML 1.0 forbids (U+0000 to U+0008, U+000B,
 * U+000C, U+000E to U+001F, U+FFFE, U+FFFF, and unpaired surrogates) are dropped, and the five XML
 * special characters become entities.
 */
export function escapeXml(text: string): string {
  let out = '';
  for (const ch of text) {
    if (!isXmlChar(ch.codePointAt(0)!)) continue;
    out += XML_ENTITIES[ch] ?? ch;
  }
  return out;
}

/** A US number as people write it, (402) 555-0199; any other number as it is. */
function displayPhone(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}

/** The company's contact details for a HELP reply (companyContact). */
type Contact = { name: string; phoneE164: string | null; email: string | null; website: string | null };

/*
 * The replies. Every dynamic part (the company's name and contact details) is escaped here; the
 * fixed text has no XML special characters that matter inside an element (an apostrophe is fine
 * there).
 */
const reply = {
  stop: (company: string) =>
    `You're unsubscribed from ${escapeXml(company)} texts. No more messages will be sent. Reply START to resubscribe.`,
  /**
   * HELP names the company and the first contact it has: its phone, else its email, else its
   * website, else the number the text was sent to. An empty string counts as none.
   */
  help: (contact: Contact, to: string) => {
    const name = escapeXml(contact.name);
    const tail = 'Reply STOP to opt out.';
    if (contact.phoneE164) return `${name}: call us at ${escapeXml(displayPhone(contact.phoneE164))}. ${tail}`;
    if (contact.email) return `${name}: email us at ${escapeXml(contact.email)}. ${tail}`;
    if (contact.website) return `${name}: visit ${escapeXml(contact.website)}. ${tail}`;
    return `${name}: call or text us at ${escapeXml(displayPhone(to))}. ${tail}`;
  },
  start: (company: string) => `You're resubscribed to ${escapeXml(company)} texts. Reply STOP to opt out.`,
};

/** Answers with TwiML: one <Message> (its text already escaped), or an empty <Response/>. */
function sendTwiml(res: Response, messageXml?: string): void {
  const body = messageXml === undefined ? '<Response/>' : `<Response><Message>${messageXml}</Message></Response>`;
  res.status(200).type('text/xml').send(XML_HEAD + body);
}

/** A form field, only when it is a single string (a repeated or missing field is undefined). */
export function field(req: Request, name: string): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  return typeof value === 'string' ? value : undefined;
}

/** Whether the form has this field at all, in any shape. */
function sent(req: Request, name: string): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  return body?.[name] !== undefined;
}

/**
 * Step 3: the request's MessageSid in Twilio's format, with SmsSid (when sent) in it too; else
 * null, and the caller answers 400.
 */
function messageSidOf(req: Request): string | null {
  const messageSid = field(req, 'MessageSid');
  if (messageSid === undefined || !MESSAGE_SID.test(messageSid)) return null;
  if (sent(req, 'SmsSid')) {
    const smsSid = field(req, 'SmsSid');
    if (smsSid === undefined || !MESSAGE_SID.test(smsSid)) return null;
  }
  return messageSid;
}

/** A form field that must be an E.164 number; else undefined. */
function e164Field(req: Request, name: string): string | undefined {
  const value = field(req, name);
  return value !== undefined && E164.test(value) ? value : undefined;
}

/** The sender of a text (`From`): an E.164 number or a short code; else undefined. */
function senderField(req: Request): string | undefined {
  const value = field(req, 'From');
  return value !== undefined && (E164.test(value) || SHORT_CODE.test(value)) ? value : undefined;
}

/** Twilio's OptOutType (Advanced Opt-Out), only when it is exactly STOP, START or HELP; else undefined. */
function optOutTypeField(req: Request): OptOutType | undefined {
  const value = field(req, 'OptOutType');
  return value === 'STOP' || value === 'START' || value === 'HELP' ? value : undefined;
}

const systemCtx = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

/**
 * Step 2 (the signature), for a request already routed to `companyId`: checked with that company's
 * token (else TWILIO_AUTH_TOKEN). Answers 403 itself and returns null; otherwise the company's id.
 */
export async function checkSignature(deps: AppDeps, req: Request, res: Response, companyId: string): Promise<string | null> {
  const { system } = deps.pools;
  const token = await signingTokenFor(system, companyId, deps.config.TWILIO_AUTH_TOKEN, deps.config.ENCRYPTION_KEY);
  const signature = req.get('X-Twilio-Signature');
  const url = deps.config.PUBLIC_BASE_URL + req.originalUrl;
  if (token === null || signature === undefined || !twilio.validateRequest(token, signature, url, req.body ?? {})) {
    res.status(403).end();
    return null;
  }
  return companyId;
}

/**
 * Steps 1 and 2 (routing, then the signature), on `numberField` (the company's own number).
 * `options` go to companyIdForNumber: `includeInactive` routes a number whatever its status (a text
 * that came in, so a STOP still opts out); without it only active numbers route.
 * Answers 404 or 403 itself and returns null; otherwise the company's id.
 */
async function verify(
  deps: AppDeps,
  req: Request,
  res: Response,
  numberField: 'To' | 'From',
  options?: { includeInactive?: boolean },
): Promise<string | null> {
  const { system } = deps.pools;
  const number = field(req, numberField);
  const companyId = number !== undefined && E164.test(number) ? await companyIdForNumber(system, number, options) : null;
  if (companyId === null) {
    res.status(404).end();
    return null;
  }
  return checkSignature(deps, req, res, companyId);
}

/**
 * Steps 1 and 2 for a delivery report. Routed by `From` (the company's number, whatever its status,
 * so a report for a released number is still applied); when `From` is missing, not E.164, or no
 * company owns it, by `MessagingServiceSid` (texting_registrations). Else 404. Then the signature,
 * with that company's token. Answers 404 or 403 itself and returns null; otherwise the company's id.
 */
async function routeStatus(deps: AppDeps, req: Request, res: Response): Promise<string | null> {
  const { system } = deps.pools;
  const from = field(req, 'From');
  let companyId = from !== undefined && E164.test(from) ? await companyIdForNumber(system, from, { includeInactive: true }) : null;
  if (companyId === null) {
    const serviceSid = field(req, 'MessagingServiceSid');
    if (serviceSid !== undefined && MESSAGING_SERVICE_SID.test(serviceSid)) {
      companyId = await companyIdForMessagingService(system, serviceSid);
    }
  }
  if (companyId === null) {
    res.status(404).end();
    return null;
  }
  return checkSignature(deps, req, res, companyId);
}

/** Twilio's OptOutType values we act on. */
type OptOutType = 'STOP' | 'START' | 'HELP';

/**
 * A text that came in. `from` is the sender's E.164 number or a short code. `optOutType` is Twilio's
 * OptOutType when it sent one (Advanced Opt-Out): it decides STOP / START / HELP instead of the body.
 */
type Inbound = { messageSid: string; from: string; to: string; body: string; optOutType?: OptOutType };

/**
 * What the text is: Twilio's OptOutType when it is set (for STOP, the keyword is the body, normalized,
 * or 'STOP' when the body is empty), else what the body reads as.
 */
function readingOf(text: Inbound): InboundReading {
  switch (text.optOutType) {
    case 'STOP':
      return { kind: 'stop', keyword: text.body.trim().toUpperCase() || 'STOP' };
    case 'START':
      return { kind: 'start', keyword: 'START' };
    case 'HELP':
      return { kind: 'help', keyword: 'HELP' };
    case undefined:
      return readInbound(text.body);
  }
}

/**
 * A text that came in, for the company, in one transaction. Returns the reply (escaped), or
 * undefined for none.
 * - A short-code sender is stored as received (customer null), and nothing else happens: no
 *   classification, no locks, no opt-out, no reply.
 * - Otherwise the sender's texting locks are taken first where the reading needs them (STOP: every
 *   customer with the number, archived ones too, so a send deciding for one of them right now
 *   finishes first; START: the active ones), then the message is stored, filed under the first
 *   active customer with the sender's number. A repeat of the same MessageSid is stored already:
 *   nothing more happens and there is no reply.
 * - STOP: the number goes on the opt-out list and all of them are revoked (`revokeConsentByText`).
 *   With no customer, the number is still put on the list. When Twilio sent the STOP as OptOutType,
 *   Twilio already answered, so there is no reply from us.
 * - HELP: the company's name and first contact (`reply.help`); always answered.
 * - START: under the active customers' locks, the number comes off the opt-out list and the revoked
 *   ones are back to `express` (`restoreConsentByText`). Do-not-contact stays as it is. As for STOP,
 *   an OptOutType START gets no reply from us.
 * - anything else: no reply; a message that reads like an opt-out is flagged for a person to
 *   check, on each active customer's timeline or, with none, on the message's own; nobody is opted out.
 */
async function handleInbound(deps: AppDeps, companyId: string, text: Inbound): Promise<string | undefined> {
  const ctx = systemCtx(companyId);
  const now = deps.clock.now();

  if (!E164.test(text.from)) {
    await withTenant(deps.pools, ctx, (tx) =>
      insertInboundText(tx, ctx, { customerId: null, body: text.body, fromE164: text.from, toE164: text.to, providerSid: text.messageSid }, now),
    );
    return undefined;
  }

  const reading = readingOf(text);
  const twilioAnswered = text.optOutType === 'STOP' || text.optOutType === 'START';
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
    if (messageId === null) return undefined;

    switch (reading.kind) {
      case 'stop':
        await revokeConsentByText(tx, ctx, { phoneE164: text.from, keyword: reading.keyword, customerIds: all, messageId }, now);
        return twilioAnswered ? undefined : reply.stop(company.name);
      case 'help':
        return reply.help(company, text.to);
      case 'start':
        await restoreConsentByText(tx, ctx, { phoneE164: text.from, customerIds: active, messageId }, now);
        return twilioAnswered ? undefined : reply.start(company.name);
      case 'other': {
        if (looksLikeOptOut(text.body)) await flagPossibleOptOut(tx, ctx, active, messageId, now);
        {
          const storm = await onStormReply(tx, ctx, { id: messageId, customerId: active[0] ?? null, body: text.body }, now);
          if (storm.consumed) return undefined;
        }
        // Inbound handler order (Ruling AV): STOP/HELP/START (above), then S1 onStormReply, then G1 claims, then Front Desk.
        // G1 Agents: a reply to a claims text goes to the Claims agent (Ruling GX-A), which consumes it: its job later
        // answers "Thanks, got it." or hands the reply back to Front Desk (Ruling GX-V). It runs in this transaction, so a
        // failure rolls the message back and Twilio's retry handles it again; it must stay a quick read and a job send.
        let consumed = false;
        const customerId = active[0];
        if (customerId !== undefined) {
          consumed = (await onClaimsReply(tx, deps, { companyId, customerId, messageId, body: text.body, receivedAt: now })).consumed;
        }
        // Front Desk still files a consumed text into its conversation (so the reply or the hand-on lands there); it
        // queues no answer of its own for it.
        if (!looksLikeOptOut(text.body) && (await frontDeskTextsOn(tx, ctx))) {
          const conv = await attachInboundToConversation(
            tx,
            ctx,
            { messageId, phoneE164: text.from, companyNumberE164: text.to, customerId: active[0] ?? null },
            now,
          );
          await queueFrontDeskText(tx, { id: messageId, conversationId: conv.id, companyId }, { jobs: deps.jobs, consumed });
        }
        return undefined;
      }
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

  /**
   * A text that came in. Routed even when its number is no longer active (a STOP still opts out).
   * The sender may be a short code. A repeated delivery answers an empty reply; a failure throws, so
   * Express answers 500 and the tenant transaction rolls back.
   */
  router.post('/sms', async (req, res) => {
    const companyId = await verify(deps, req, res, 'To', { includeInactive: true });
    if (companyId === null) return;
    const messageSid = messageSidOf(req);
    const from = senderField(req);
    const to = e164Field(req, 'To');
    if (messageSid === null || from === undefined || to === undefined) {
      res.status(400).end();
      return;
    }
    const text: Inbound = { messageSid, from, to, body: field(req, 'Body') ?? '', optOutType: optOutTypeField(req) };
    const replyXml = await handleInbound(deps, companyId, text);
    sendTwiml(res, replyXml);
  });

  /**
   * `delivered` → delivered; `failed` / `undelivered` → failed, not retryable, with the carrier
   * reason; both only from `sent` (`recordDeliveryOutcome`), so nothing goes backwards. A report for
   * an id that is no outbound text of the company's yet is kept (early_delivery_reports) and applied
   * when its send is saved; the SID's lock makes that wait for, or be seen by, the save. Any other
   * status (queued, sending, sent, ...): 200, nothing done. Always 200 with an empty body once routed.
   */
  router.post('/status', async (req, res) => {
    const companyId = await routeStatus(deps, req, res);
    if (companyId === null) return;
    const messageSid = messageSidOf(req);
    const messageStatus = field(req, 'MessageStatus');
    if (messageSid === null || !messageStatus) {
      res.status(400).end();
      return;
    }
    const outcome = outcomeOf(messageStatus);
    if (outcome !== null) {
      const ctx = systemCtx(companyId);
      const now = deps.clock.now();
      await withTenant(deps.pools, ctx, async (tx) => {
        await lockDeliverySid(tx, ctx, messageSid);
        const result = await recordDeliveryOutcome(tx, ctx, messageSid, outcome, now);
        if (result === 'unknown_sid') {
          await saveEarlyDeliveryReport(
            tx,
            ctx,
            { providerSid: messageSid, status: outcome.status, reason: outcome.status === 'failed' ? outcome.reason : null },
            now,
          );
        }
      });
    }
    res.status(200).end();
  });

  return router;
}
