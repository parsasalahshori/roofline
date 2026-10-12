/** A short, plain date and clock time for a feed or waiting row, e.g. "Oct 12, 3:05 PM". */
const OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

/** `zone` is the company's IANA time zone (useCompany().data?.timezone); undefined or invalid falls back to the browser zone. */
export function agentTimeLabel(iso: string, zone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { ...OPTIONS, timeZone: zone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', OPTIONS).format(date);
  }
}

/** Clock time only, e.g. "3:05 PM", in the company zone. */
export function agentClockLabel(iso: string, zone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).format(date).replace(/[\u202F\u00A0]/g, ' ');
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(date).replace(/[\u202F\u00A0]/g, ' ');
  }
}
