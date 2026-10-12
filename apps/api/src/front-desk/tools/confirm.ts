import {
  confirmAppointment,
  type FdAppointment,
  updateConversation,
  upcomingForCustomer,
  withTenant,
} from '@roofline/db';
import type { AppDeps } from '../../app.ts';
import type { ToolHandler } from '../engine-types.ts';
import { isAvailable as timesAvailable, systemCtx, whenShort, zoneOf } from './times.ts';

/*
 * D1 Task 8: confirm_appointment (any kind of visit, for the verified caller only) and the text
 * shortcut: a customer who texts "C" or "confirm" confirms their next visit (texts.ts calls
 * confirmByText for it, before the engine).
 */

export const NOT_VERIFIED =
  'I can only confirm a visit for a caller I have verified. Use verify_caller first, or offer to take a message.';
export const NOT_FOUND_VISIT = 'I could not find that visit for this caller. Offer to take a message so someone calls them back.';

export const NOTHING_TO_CONFIRM = "I don't see a visit to confirm for this number. Call us and we will sort it out.";

/** Always in the tool list. */
export const isAvailable = timesAvailable;

const KIND_WORD: Record<FdAppointment['kind'], string> = {
  inspection: 'inspection',
  install: 'install',
  adjuster: 'adjuster visit',
  other: 'visit',
};

/** True for a text that is only "C" or "confirm" (any case, with spaces or a full stop around it). */
export function isConfirmShortcut(text: string): boolean {
  return /^\s*(c|confirm)\s*[.!]?\s*$/i.test(text);
}

export const confirmAppointmentTool: ToolHandler<'confirm_appointment'> = async (ctx, input) => {
  const { deps, companyId, conversation, now } = ctx;
  if (conversation.identity !== 'verified' || conversation.customerId === null) {
    return { ok: false, forModel: NOT_VERIFIED };
  }
  const customerId = conversation.customerId;
  const tctx = systemCtx(companyId);
  const done = await withTenant(deps.pools, tctx, async (tx) => {
    const result = await confirmAppointment(
      tx,
      tctx,
      { appointmentId: input.appointmentId, customerId, via: conversation.channel === 'voice' ? 'call' : 'text' },
      now,
    );
    if (result.outcome === 'confirmed') await updateConversation(tx, tctx, conversation.conversationId, { outcome: 'confirmed' });
    return { ...result, zone: await zoneOf(tx, tctx) };
  });
  if (done.outcome === 'not_found' || done.row === null) return { ok: false, forModel: NOT_FOUND_VISIT };
  const when = whenShort(done.row.startsAt, done.zone);
  return {
    ok: true,
    forModel:
      done.outcome === 'already'
        ? `That ${KIND_WORD[done.row.kind]} on ${when} is already confirmed.`
        : `Confirmed the ${KIND_WORD[done.row.kind]} on ${when}.`,
    action: 'confirmed',
  };
};

/**
 * The reply to a "C" or "confirm" text: confirms the customer's next visit that is not confirmed yet
 * and says so in one plain sentence. With nothing to confirm it says that. The sender is the
 * customer the number belongs to (the text came from it), so no name check is asked for.
 */
export async function confirmByText(
  deps: AppDeps,
  i: { companyId: string; conversationId: string; customerId: string },
  now: Date,
): Promise<string> {
  const tctx = systemCtx(i.companyId);
  return withTenant(deps.pools, tctx, async (tx) => {
    const upcoming = await upcomingForCustomer(tx, tctx, i.customerId, now, 10);
    const next = upcoming.find((a) => a.confirmedAt === null) ?? upcoming[0];
    if (!next) return NOTHING_TO_CONFIRM;
    const zone = await zoneOf(tx, tctx);
    const label = `${KIND_WORD[next.kind]} on ${whenShort(next.startsAt, zone)}`;
    if (next.confirmedAt !== null) return `Your ${label} is already confirmed.`;
    const result = await confirmAppointment(tx, tctx, { appointmentId: next.id, customerId: i.customerId, via: 'text' }, now);
    if (result.outcome === 'not_found') return NOTHING_TO_CONFIRM;
    await updateConversation(tx, tctx, i.conversationId, { outcome: 'confirmed' });
    return `Thanks, your ${label} is confirmed.`;
  });
}
