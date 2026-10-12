/** A short, plain date and clock time for a feed or waiting row, e.g. "Oct 12, 3:05 PM". */
const FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function agentTimeLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : FORMAT.format(date);
}
