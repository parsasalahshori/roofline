/** The Crew weather and What your AI just did cards on the map home page. */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A YYYY-MM-DD date has no zone: it is read as UTC both ways, so the weekday is the date's own. */
function weekday(date: string, style: 'short' | 'long'): string {
  const at = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: style }).format(at);
}

export const liftFeed = {
  // Crew weather
  weatherTitle: 'Crew weather',
  weatherLoading: 'Loading the forecast',
  weatherDaysLabel: 'Forecast for the next six days',
  today: 'Today',
  dayShort: (date: string) => weekday(date, 'short'),
  dayLong: (date: string) => weekday(date, 'long'),
  /** The day's own words for a screen reader, e.g. "Monday, high 68 degrees, 80 percent chance of rain". */
  dayLabel: (date: string, highF: number | null, rainPct: number | null) =>
    [
      weekday(date, 'long'),
      highF === null ? '' : `high ${Math.round(highF)} degrees`,
      rainPct === null ? '' : `${rainPct} percent chance of rain`,
    ]
      .filter((part) => part !== '')
      .join(', '),
  high: (highF: number | null) => (highF === null ? '—' : `${Math.round(highF)}°`),
  rain: (pct: number | null) => (pct === null ? '—' : `${Math.round(pct)}%`),
  atRisk: (jobs: number) => (jobs === 1 ? '1 job at risk' : `${jobs} jobs at risk`),
  schedulerCanMove: (tearOffs: number, day: string) =>
    `Scheduler can move ${tearOffs} ${tearOffs === 1 ? 'tear-off' : 'tear-offs'} off ${day} and text each homeowner.`,

  // What your AI just did
  feedTitle: 'What your AI just did',
  feedLoading: 'Loading what your agents did',
  feedListLabel: 'The latest things your agents did',
  feedEmpty: 'Nothing yet. What your agents do will show up here.',
  feedLoadError: 'Could not load what your agents did.',
  working: (count: number) => `${count} working`,
  /** "Front Desk, 3 hr ago" */
  byline: (agent: string, when: string) => `${agent}, ${when}`,
  /** How long ago, from the row's instant and now: "just now", "12 min ago", "3 hr ago", "2 days ago". */
  ago: (iso: string, now: number): string => {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return '';
    const ms = Math.max(0, now - at);
    if (ms < MINUTE_MS) return 'just now';
    if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min ago`;
    if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} hr ago`;
    const days = Math.floor(ms / DAY_MS);
    return days === 1 ? '1 day ago' : `${days} days ago`;
  },
};
