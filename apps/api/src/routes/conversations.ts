import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  decodeInboxCursor,
  findVisibleConversation,
  getConversation,
  getConversationDetail,
  insertAssistantText,
  listConversationInbox,
  lockRecipient,
  markConversationRead,
  setConversationHandling,
  TEAM_HANDLING_MS,
  withTenant,
} from '@roofline/db';
import type { InboxScope, TenantContext } from '@roofline/db';
import { CONVERSATION_FILTERS, HANDLED_BY } from '@roofline/shared';
import type { ConversationFilter, ReplyResult } from '@roofline/shared';
import { inboxScopeOf } from '../account/inbox-scope.ts';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { buildGateRequest } from '../messaging/gate-request.ts';
import { sendQueuedText, textStateFor, UNCONFIRMED } from '../messaging/outbound.ts';
import { parse, UUID } from '../validate.ts';

const NOT_BUILT = 'This part of Front Desk (conversations) is not built yet.';
const BAD_FILTER = 'Please pick one of the filters on the list.';
const BAD_CURSOR = 'That page link is not valid. Please reload the list.';
const BAD_HANDLING = 'Please choose who is handling this conversation.';
const BODY_REQUIRED = 'Please write a message first.';
const BODY_TOO_LONG = 'That message is too long. Please keep it under 1,600 characters.';
const TEXT_ONLY = 'Only text conversations can be replied to.';
const NO_CUSTOMER = 'This number is not linked to a customer yet, so we cannot text it.';
const NO_MOBILE = 'No mobile number on file.';
const SEND_FAILED = 'We could not send this text.';

const MAX_REPLY_CHARS = 1600;

const replySchema = z.object({
  body: z
    .string({ error: BODY_REQUIRED })
    .trim()
    .min(1, BODY_REQUIRED)
    .max(MAX_REPLY_CHARS, BODY_TOO_LONG)
    .refine((v) => !v.includes('\0'), BODY_REQUIRED),
});

const handlingSchema = z.object({ by: z.enum(HANDLED_BY, { error: BAD_HANDLING }) });

/**
 * `/api/conversations`: the Front Desk inbox.
 * - `GET /?filter=&cursor=`: `ConversationPage`, newest first, 30 a page.
 * - `GET /:id`: `ConversationDetail` (a turn's text is null when it was not kept or was swept).
 * - `POST /:id/reply { body }`: a staff text through the send gate (informational). Answers 200
 *   `ReplyResult` (`{ id, status: 'sent' | 'scheduled', scheduledFor }`) when it went out or will go out
 *   later. When the gate blocks it, or the text could not be sent, it is a 422 with the plain reason
 *   (nothing is kept for a block, so the draft stays the person's to edit). A reply never changes who
 *   is handling the conversation: the assistant keeps quiet for 2 hours after a team text on its own
 *   (texts.ts), and only the "Team is handling" switch hands the conversation over.
 * - `POST /:id/handling { by }`: `{ id, handledBy, teamUntil }`.
 * - `POST /:id/read`: `{ id }`.
 * Owner and office see every conversation; a rep sees their own customers' (and unknown numbers
 * only while on call). Anything else, and any id that is not one of these, is a 404.
 */
export function conversationRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  const conversationId = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    return id;
  };

  /** A rep's unknown-number access depends on the on-call list, which only the system pool can read. */
  const scopeOf = (ctx: TenantContext): Promise<InboxScope> => inboxScopeOf(deps, ctx);

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const rawFilter = req.query.filter;
    let filter: ConversationFilter = 'all';
    if (rawFilter !== undefined && rawFilter !== '') {
      if (typeof rawFilter !== 'string' || !(CONVERSATION_FILTERS as readonly string[]).includes(rawFilter)) {
        throw new AppError(400, BAD_FILTER, 'filter');
      }
      filter = rawFilter as ConversationFilter;
    }
    const rawCursor = req.query.cursor;
    let cursor: string | null = null;
    if (rawCursor !== undefined && rawCursor !== '') {
      if (typeof rawCursor !== 'string' || decodeInboxCursor(rawCursor) === null) throw new AppError(400, BAD_CURSOR, 'cursor');
      cursor = rawCursor;
    }
    const scope = await scopeOf(ctx);
    const page = await withTenant(pools, ctx, (tx) => listConversationInbox(tx, ctx, scope, { filter, cursor }));
    res.json(page);
  });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const id = conversationId(req.params.id);
    const scope = await scopeOf(ctx);
    const detail = await withTenant(pools, ctx, (tx) => getConversationDetail(tx, ctx, scope, id));
    if (!detail) throw new AppError(404, MESSAGES.notFound);
    res.json(detail);
  });

  router.post('/:id/read', async (req, res) => {
    const { ctx } = req;
    const id = conversationId(req.params.id);
    const scope = await scopeOf(ctx);
    const found = await withTenant(pools, ctx, async (tx) => {
      if (!(await findVisibleConversation(tx, ctx, scope, id))) return false;
      return markConversationRead(tx, ctx, id);
    });
    if (!found) throw new AppError(404, MESSAGES.notFound);
    res.json({ id });
  });

  router.post('/:id/handling', async (req, res) => {
    const { ctx } = req;
    const id = conversationId(req.params.id);
    const { by } = parse(handlingSchema, req.body);
    const scope = await scopeOf(ctx);
    const teamUntil = by === 'team' ? new Date(clock.now().getTime() + TEAM_HANDLING_MS) : null;
    const found = await withTenant(pools, ctx, async (tx) => {
      if (!(await findVisibleConversation(tx, ctx, scope, id))) return false;
      return setConversationHandling(tx, ctx, id, by, teamUntil);
    });
    if (!found) throw new AppError(404, MESSAGES.notFound);
    res.json({ id, handledBy: by, teamUntil: teamUntil === null ? null : teamUntil.toISOString() });
  });

  router.post('/:id/reply', async (req, res) => {
    const { ctx } = req;
    const id = conversationId(req.params.id);
    const { body } = parse(replySchema, req.body);
    const scope = await scopeOf(ctx);
    const now = clock.now();

    const outcome = await withTenant(pools, ctx, async (tx) => {
      const convo = await findVisibleConversation(tx, ctx, scope, id);
      if (!convo) throw new AppError(404, MESSAGES.notFound);
      if (convo.channel !== 'sms') throw new AppError(409, TEXT_ONLY);
      const customerId = convo.customerId;
      if (customerId === null) throw new AppError(409, NO_CUSTOMER);
      const dedupeKey = `fd-reply:${id}:${randomUUID()}`;
      await lockRecipient(tx, ctx, customerId);
      // Reply to the number that texted; the gate uses it only when it is one of the customer's numbers.
      const toE164 = (await getConversation(tx, ctx, id))?.phoneE164 ?? null;
      const built = await buildGateRequest(
        tx,
        ctx,
        { customerId, purpose: 'informational', body, bodyRendered: true, dedupeKey, replyToInboundAt: null, toE164 },
        now,
      );
      if (!built) throw new AppError(404, MESSAGES.notFound);
      let state = textStateFor(built);
      if (state.status === 'queued' && built.toE164 === null) {
        state = { status: 'blocked', blockRule: 'contact', blockReason: NO_MOBILE };
      }
      // Nothing will be sent: say why, and keep nothing (throwing rolls the transaction back).
      if (state.status === 'blocked' || state.status === 'failed') throw new AppError(422, state.blockReason);
      const messageId = await insertAssistantText(
        tx,
        ctx,
        { conversationId: id, customerId, body, toE164: built.toE164, dedupeKey },
        state,
        now,
      );
      if (messageId === null) throw new AppError(409, SEND_FAILED);
      return { messageId, state, to: built.toE164, sender: built.sender };
    });

    const { state } = outcome;
    if (state.status === 'scheduled') {
      const result: ReplyResult = { id: outcome.messageId, status: 'scheduled', scheduledFor: state.scheduledFor.toISOString() };
      res.json(result);
      return;
    }
    if (outcome.to === null) throw new AppError(422, NO_MOBILE);
    const sent = await sendQueuedText(deps, ctx, { messageId: outcome.messageId, to: outcome.to, body, sender: outcome.sender }, SEND_FAILED);
    // The row says what happened; a text the provider may have sent anyway is never sent again.
    if (sent === 'unknown') throw new AppError(422, UNCONFIRMED);
    if (sent !== 'sent') throw new AppError(422, SEND_FAILED);
    const result: ReplyResult = { id: outcome.messageId, status: 'sent', scheduledFor: null };
    res.json(result);
  });

  router.all('/{*rest}', (_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  return router;
}
