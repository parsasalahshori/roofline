import {
  alternativeOptions,
  INSPECTION_MINUTES,
  optionLine,
  openInspectionSlots,
  queueCalendarPush,
  systemCtx,
  type ToolSettings,
  verifiedCustomerId,
  whenWords,
  zoneOf,
} from './times.ts';
import {
  AppointmentLinkError,
  clearConfirmation,
  getFdAppointment,
  getFrontDeskSettings,
  lockInspector,
  setAppointmentStatus,
  type FdAppointment,
  updateAppointment,
  updateConversation,
  withTenant,
} from '@roofline/db';
import type { ToolHandler } from '../engine-types.ts';

/*
 * D1 Task 8: move_inspection and cancel_inspection. The verified caller's own inspections only
 * (installs and other visits go to the office as a message), each behind its Settings switch. Both
 * go through C1's updateAppointment / setAppointmentStatus, so the timeline, the audit row and the
 * calendar push work as in C1.
 */

const MINUTE_MS = 60 * 1000;

export const NOT_VERIFIED_CHANGE =
  'I can only change a visit for a caller I have verified. Use verify_caller first, or offer to take a message for the office.';
export const MOVE_OFF = 'Moving visits is turned off here. Offer to take a message with take_message so the office can help.';
export const CANCEL_OFF = 'Canceling visits is turned off here. Offer to take a message with take_message so the office can help.';
export const ONLY_INSPECTIONS =
  'Only inspections can be changed here. Installs and other visits are handled by the office. Offer to take a message with take_message.';
export const NOT_FOUND_VISIT = 'I could not find that inspection for this caller. Offer to take a message so someone calls them back.';
export const NOT_INSPECTOR = 'That time is not one I offered. Look up the times again.';

/** move_inspection is in the tool list only when the owner allows moving. */
export function isMoveAvailable(settings: ToolSettings): boolean {
  return settings.canMove;
}

/** cancel_inspection is in the tool list only when the owner allows canceling. */
export function isCancelAvailable(settings: ToolSettings): boolean {
  return settings.canCancel;
}

type Found = { ok: true; appointment: FdAppointment } | { ok: false; message: string };

/** The caller's own upcoming inspection, or the sentence that says why not. */
function ownInspection(row: FdAppointment | null, customerId: string, now: Date): Found {
  if (!row || row.customerId !== customerId || row.status !== 'scheduled' || row.endsAt.getTime() <= now.getTime()) {
    return { ok: false, message: NOT_FOUND_VISIT };
  }
  if (row.kind !== 'inspection') return { ok: false, message: ONLY_INSPECTIONS };
  return { ok: true, appointment: row };
}

export const moveInspection: ToolHandler<'move_inspection'> = async (ctx, input) => {
  const { deps, companyId, conversation, now } = ctx;
  const customerId = verifiedCustomerId(conversation);
  if (customerId === null) return { ok: false, forModel: NOT_VERIFIED_CHANGE };
  const tctx = systemCtx(companyId);
  const slotStart = new Date(input.slotStart);
  const slotEnd = new Date(slotStart.getTime() + INSPECTION_MINUTES * MINUTE_MS);

  type Moved =
    | { kind: 'refused'; message: string }
    | { kind: 'taken'; alternatives: string[] }
    | { kind: 'moved'; line: string; pushFor: string | null };
  let moved: Moved;
  try {
    moved = await withTenant(deps.pools, tctx, async (tx): Promise<Moved> => {
      const settings = await getFrontDeskSettings(tx, tctx);
      if (!settings.canMove) return { kind: 'refused', message: MOVE_OFF };
      const found = ownInspection(await getFdAppointment(tx, tctx, input.appointmentId), customerId, now);
      if (!found.ok) return { kind: 'refused', message: found.message };
      const appt = found.appointment;

      await lockInspector(tx, tctx, input.slotUserId);
      const ignore = appt.assignedUserId === null ? undefined : { userId: appt.assignedUserId, start: appt.startsAt, end: appt.endsAt, propertyId: appt.propertyId };
      const fresh = await openInspectionSlots(tx, tctx, { from: slotStart, to: slotEnd, propertyId: appt.propertyId, now, ...(ignore && { ignore }) });
      const open = fresh.slots.find((s) => s.start.getTime() === slotStart.getTime() && s.userIds.includes(input.slotUserId));
      if (!open) {
        if (!fresh.names.has(input.slotUserId)) return { kind: 'refused', message: NOT_INSPECTOR };
        return {
          kind: 'taken',
          alternatives: await alternativeOptions(tx, tctx, { slotStart, takenUserId: input.slotUserId, propertyId: appt.propertyId, now, ...(ignore && { ignore }) }),
        };
      }

      const updated = await updateAppointment(
        tx,
        tctx,
        appt.id,
        { startsAt: slotStart, endsAt: slotEnd, assignedUserId: input.slotUserId },
        now,
      );
      if (!updated) return { kind: 'refused', message: NOT_FOUND_VISIT };
      await clearConfirmation(tx, tctx, appt.id, now);
      await updateConversation(tx, tctx, conversation.conversationId, { outcome: 'moved' });
      const zone = await zoneOf(tx, tctx);
      return {
        kind: 'moved',
        line: optionLine({ start: slotStart, end: slotEnd, userIds: [input.slotUserId] }, zone, fresh.names),
        pushFor: updated.pushDue ? appt.id : null,
      };
    });
  } catch (err) {
    if (err instanceof AppointmentLinkError) {
      deps.logError?.(err, 'front-desk.move');
      return { ok: false, forModel: NOT_FOUND_VISIT };
    }
    throw err;
  }

  if (moved.kind === 'refused') return { ok: false, forModel: moved.message };
  if (moved.kind === 'taken') {
    return {
      ok: false,
      forModel:
        moved.alternatives.length > 0
          ? `That time was just taken. Say so and offer these two instead, in words, not the codes:\n${moved.alternatives.map((a) => `- ${a}`).join('\n')}`
          : 'That time was just taken and nothing else is open. Offer to take a message so someone calls them back.',
    };
  }
  if (moved.pushFor !== null) await queueCalendarPush(deps, companyId, moved.pushFor);
  return { ok: true, forModel: `Moved the inspection to ${moved.line.replace(/ \(slotStart.*$/, '')}.`, action: 'moved' };
};

export const cancelInspection: ToolHandler<'cancel_inspection'> = async (ctx, input) => {
  const { deps, companyId, conversation, now } = ctx;
  const customerId = verifiedCustomerId(conversation);
  if (customerId === null) return { ok: false, forModel: NOT_VERIFIED_CHANGE };
  const tctx = systemCtx(companyId);

  const done = await withTenant(deps.pools, tctx, async (tx) => {
    const settings = await getFrontDeskSettings(tx, tctx);
    if (!settings.canCancel) return { kind: 'refused' as const, message: CANCEL_OFF };
    const found = ownInspection(await getFdAppointment(tx, tctx, input.appointmentId), customerId, now);
    if (!found.ok) return { kind: 'refused' as const, message: found.message };
    const reason = input.reason.trim();
    const result = await setAppointmentStatus(tx, tctx, found.appointment.id, 'canceled', now, reason === '' ? {} : { note: reason });
    if (!result) return { kind: 'refused' as const, message: NOT_FOUND_VISIT };
    await updateConversation(tx, tctx, conversation.conversationId, { outcome: 'canceled' });
    const zone = await zoneOf(tx, tctx);
    return {
      kind: 'canceled' as const,
      when: whenWords(found.appointment.startsAt, zone),
      pushFor: result.pushDue ? found.appointment.id : null,
    };
  });

  if (done.kind === 'refused') return { ok: false, forModel: done.message };
  if (done.pushFor !== null) await queueCalendarPush(deps, companyId, done.pushFor);
  return { ok: true, forModel: `Canceled the inspection on ${done.when}. Offer to book a new time if they want one.`, action: 'canceled' };
};
