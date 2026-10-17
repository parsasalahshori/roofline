import { approvals } from '../../copy/approvals.ts';
import { formatDayLabel, formatTime } from '../calendar/time.ts';
import { useCompany } from '../settings/api.ts';
import { DEFAULT_ZONE } from './steps/payload.ts';
import { dateOf, isAllDay } from './steps/MoveAppointmentPreview.tsx';

/**
 * When an install moves to, in the words of a card's fact: the new day, with the hours when the move has them. The times
 * are the company's own zone, so a card says the same day the calendar does. A time that cannot be read says nothing.
 */
export function MoveWhen({ start, end }: { start: string; end: string }) {
  const company = useCompany();
  const zone = company.data?.timezone ?? DEFAULT_ZONE;
  const from = dateOf(start);
  if (from === null) return null;
  const to = dateOf(end);
  const day = formatDayLabel(from, zone);
  if (to === null || isAllDay(from, to, zone)) return <>{day}</>;
  return <>{approvals.moveWhenAt(day, formatTime(from, zone), formatTime(to, zone))}</>;
}
