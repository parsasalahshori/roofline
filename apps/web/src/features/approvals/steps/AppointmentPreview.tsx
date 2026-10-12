import { stepVisits } from '../../../copy/stepVisits.ts';
import type { StepView } from '../../../api/types.ts';
import { dateKeyToInstant, formatDayLabel, formatTime, zonedDateKey } from '../../calendar/time.ts';
import { useCompany, useTeam } from '../../settings/api.ts';
import styles from './AppointmentPreview.module.css';
import type { EditFieldSpec, EditValues, StepKit, StepKitContext, StepPreviewProps } from './types.ts';

type Payload = Record<string, unknown>;

const DEFAULT_ZONE = 'America/Chicago';
const NOTE_LIMIT = 500;

function payloadOf(step: StepView): Payload {
  const payload: unknown = step.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Payload) : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function instantOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** "9:30 AM", "9:30am", "09:30" or "14:30" as hours and minutes; null when unreadable. */
function parseClock(text: string): { h: number; m: number } | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?\s*$/i.exec(text);
  if (match === null) return null;
  let h = Number(match[1]);
  const m = Number(match[2]);
  if (m > 59) return null;
  const suffix = match[3]?.[0]?.toLowerCase();
  if (suffix !== undefined) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (suffix === 'p' ? 12 : 0);
  } else if (h > 23) {
    return null;
  }
  return { h, m };
}

/** The instant of a zone day (YYYY-MM-DD) at a clock time; null when either is unreadable. */
function instantAt(date: string, clock: string, zone: string): Date | null {
  const parts = parseClock(clock);
  if (parts === null) return null;
  try {
    const midnight = dateKeyToInstant(date, zone);
    if (!Number.isFinite(midnight.getTime()) || zonedDateKey(midnight, zone) !== date) return null;
    return new Date(midnight.getTime() + (parts.h * 60 + parts.m) * 60_000);
  } catch {
    return null;
  }
}

/** The visit under a create_appointment step: kind, day and time, who it is for, and the note. */
export function AppointmentPreview({ step }: StepPreviewProps) {
  const company = useCompany();
  const team = useTeam();
  const payload = payloadOf(step);
  const zone = company.data?.timezone ?? DEFAULT_ZONE;
  const kind = payload.kind === 'adjuster' || payload.kind === 'inspection' ? stepVisits.kind[payload.kind] : '';
  const start = instantOf(payload.start);
  const end = instantOf(payload.end);
  const when =
    start !== null && end !== null
      ? stepVisits.timeLine(formatDayLabel(start, zone), formatTime(start, zone), formatTime(end, zone))
      : '';
  const userId = textOf(payload.userId).toLowerCase();
  const member = team.data?.members.find((m) => m.userId.toLowerCase() === userId);
  const note = textOf(payload.note);

  return (
    <div className={styles.preview}>
      {kind !== '' ? <p className={styles.kind}>{kind}</p> : null}
      {when !== '' ? <p className={styles.when}>{when}</p> : null}
      <p className={styles.who}>{stepVisits.forMember(member?.name ?? stepVisits.aTeamMember)}</p>
      {note !== '' ? <p className={styles.note}>{note}</p> : null}
    </div>
  );
}

function editFields(step: StepView, ctx?: StepKitContext): EditFieldSpec[] {
  const zone = ctx?.zone ?? DEFAULT_ZONE;
  const payload = payloadOf(step);
  const start = instantOf(payload.start);
  const end = instantOf(payload.end);
  return [
    { id: 'date', label: stepVisits.dateLabel, kind: 'text', value: start === null ? '' : zonedDateKey(start, zone) },
    {
      id: 'start',
      label: stepVisits.startLabel,
      kind: 'text',
      value: start === null ? '' : formatTime(start, zone),
      help: stepVisits.timeHelp,
    },
    { id: 'end', label: stepVisits.endLabel, kind: 'text', value: end === null ? '' : formatTime(end, zone) },
    { id: 'note', label: stepVisits.noteLabel, kind: 'multiline', value: textOf(payload.note) },
  ];
}

function toPayload(step: StepView, values: EditValues, ctx?: StepKitContext): Record<string, unknown> {
  const zone = ctx?.zone ?? DEFAULT_ZONE;
  const payload = payloadOf(step);
  const date = String(values.date ?? '').trim();
  const start = instantAt(date, String(values.start ?? ''), zone);
  const end = instantAt(date, String(values.end ?? ''), zone);
  return {
    ...payload,
    start: start === null ? payload.start : start.toISOString(),
    end: end === null ? payload.end : end.toISOString(),
    note: String(values.note ?? ''),
  };
}

function fieldErrors(_step: StepView, values: EditValues, ctx?: StepKitContext): Record<string, string> {
  const zone = ctx?.zone ?? DEFAULT_ZONE;
  const errors: Record<string, string> = {};
  const date = String(values.date ?? '').trim();
  const startText = String(values.start ?? '');
  const endText = String(values.end ?? '');
  // A real day is one that reads back as itself.
  let dateOk: boolean;
  try {
    dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date) && zonedDateKey(dateKeyToInstant(date, zone), zone) === date;
  } catch {
    dateOk = false;
  }
  if (!dateOk) errors.date = stepVisits.dateError;
  const startClock = parseClock(startText);
  const endClock = parseClock(endText);
  if (startClock === null) errors.start = stepVisits.timeError;
  if (endClock === null) errors.end = stepVisits.timeError;
  if (startClock !== null && endClock !== null && endClock.h * 60 + endClock.m <= startClock.h * 60 + startClock.m) {
    errors.end = stepVisits.endBeforeStart;
  }
  if (String(values.note ?? '').length > NOTE_LIMIT) errors.note = stepVisits.noteTooLong;
  return errors;
}

export const createAppointmentKit: StepKit = {
  Preview: AppointmentPreview,
  review: (step) => ({ ...step.preview }),
  editFields,
  toPayload,
  fieldErrors,
};
