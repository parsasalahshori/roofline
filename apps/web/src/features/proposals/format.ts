import { proposals } from '../../copy/proposals.ts';

/** The clock time as "7:12 PM". Intl may put a narrow no-break space before AM/PM; it becomes a plain space. */
function clock(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone })
    .format(date)
    .replace(/\s/g, ' ');
}

/** The calendar day of an instant in a zone, as a day count (UTC midnight of the local Y-M-D), so days subtract cleanly. */
function dayNumber(date: Date, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone }).formatToParts(date);
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(pick('year'), pick('month') - 1, pick('day')) / 86_400_000;
}

/** "today 7:12 PM", "yesterday 7:12 PM", or "Oct 9 7:12 PM", in the given zone (undefined: the browser's). */
export function formatLastOpened(iso: string, now: Date, timeZone: string | undefined): string {
  const date = new Date(iso);
  const time = clock(date, timeZone);
  const diff = dayNumber(now, timeZone) - dayNumber(date, timeZone);
  if (diff === 0) return `${proposals.today} ${time}`;
  if (diff === 1) return `${proposals.yesterday} ${time}`;
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(date);
  return `${day} ${time}`;
}

/** The same label for sent, signed and declined lines. */
export const formatWhen = formatLastOpened;
