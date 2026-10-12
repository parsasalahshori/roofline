import { stepMoves } from '../../../copy/stepMoves.ts';
import type { StepView } from '../../../api/types.ts';
import { dateKeyToInstant, formatDayLabel, formatTime, startOfZonedDay, zonedDateKey, zonedParts, zonedWallToInstant } from '../../calendar/time.ts';
import { useAppointment } from '../../appointments/api.ts';
import { useCompany, useTeam } from '../../settings/api.ts';
import styles from './MoveAppointmentPreview.module.css';
import { DEFAULT_ZONE, payloadOf, textOf } from './payload.ts';
import type { EditFieldSpec, EditValues, StepKit, StepKitContext, StepPreviewProps } from './types.ts';

const HOUR_MS = 3_600_000;
const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The move is a whole-day one when it starts at the zone's midnight and lasts at least 20 hours. */
function isAllDay(start: Date, end: Date | null, zone: string): boolean {
  if (end === null) return true;
  return startOfZonedDay(start, zone).getTime() === start.getTime() && end.getTime() - start.getTime() >= 20 * HOUR_MS;
}

/** The move under a move_appointment step: the new day (and times), the reason and who it is for. */
export function MoveAppointmentPreview({ step }: StepPreviewProps) {
  const company = useCompany();
  const team = useTeam();
  const zone = company.data?.timezone ?? DEFAULT_ZONE;
  const payload = payloadOf(step);
  const start = dateOf(payload.start);
  const end = dateOf(payload.end);
  const reason = textOf(payload.reason);
  const userId = textOf(payload.userId).toLowerCase();
  const member = userId === '' ? undefined : team.data?.members.find((m) => m.userId.toLowerCase() === userId);
  const appointmentId = textOf(payload.appointmentId);
  const current = useAppointment(appointmentId === '' ? undefined : appointmentId);
  const oldStart = dateOf(current.data?.startsAt);

  let title: string = stepMoves.fallbackTitle;
  if (start !== null) {
    const day = formatDayLabel(start, zone);
    title =
      end === null || isAllDay(start, end, zone) ? stepMoves.moveTo(day) : stepMoves.moveToAt(day, formatTime(start, zone), formatTime(end, zone));
  }

  return (
    <div className={styles.preview}>
      <h3 className={styles.title}>{title}</h3>
      {oldStart !== null ? <p className={styles.reason}>{stepMoves.from(formatDayLabel(oldStart, zone))}</p> : null}
      {reason !== '' ? <p className={styles.reason}>{reason}</p> : null}
      <p className={styles.member}>{stepMoves.forMember(member ? member.name : stepMoves.aTeamMember)}</p>
    </div>
  );
}

function editFields(step: StepView, ctx?: StepKitContext): EditFieldSpec[] {
  const zone = ctx?.zone ?? DEFAULT_ZONE;
  const start = dateOf(payloadOf(step).start);
  return [
    {
      id: 'date',
      label: stepMoves.dateLabel,
      kind: 'text',
      value: start === null ? '' : zonedDateKey(start, zone),
      help: stepMoves.dateHelp,
    },
  ];
}

function realDay(key: string): boolean {
  const m = KEY.exec(key.trim());
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
}

function toPayload(step: StepView, values: EditValues, ctx?: StepKitContext): Record<string, unknown> {
  const payload = payloadOf(step);
  const copy = { ...payload };
  try {
    const zone = ctx?.zone ?? DEFAULT_ZONE;
    const key = String(values.date ?? '').trim();
    const start = dateOf(payload.start);
    const end = dateOf(payload.end);
    if (start === null || end === null || !realDay(key)) return copy;
    // A whole-day move keeps the zone midnight; a timed one keeps the old wall clock (9:30 AM stays 9:30 AM).
    let newStart: Date;
    if (isAllDay(start, end, zone)) {
      newStart = dateKeyToInstant(key, zone);
    } else {
      const wall = zonedParts(start, zone);
      newStart = zonedWallToInstant(key, wall.hour, wall.minute, zone);
    }
    const newEnd = new Date(newStart.getTime() + (end.getTime() - start.getTime()));
    return { ...copy, start: newStart.toISOString(), end: newEnd.toISOString() };
  } catch {
    return copy;
  }
}

function fieldErrors(_step: StepView, values: EditValues, ctx?: StepKitContext): Record<string, string> {
  const zone = ctx?.zone ?? DEFAULT_ZONE;
  const key = String(values.date ?? '').trim();
  if (!realDay(key)) return { date: stepMoves.dateError };
  if (key < zonedDateKey(new Date(), zone)) return { date: stepMoves.pastError };
  return {};
}

export const moveAppointmentKit: StepKit = {
  Preview: MoveAppointmentPreview,
  review: (step) => ({ ...step.preview }),
  editFields,
  toPayload,
  fieldErrors,
};
