const dollarFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const shortDateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Whole dollars from cents: 123456 is $1,235. */
export function formatDollars(cents: number): string {
  return dollarFormat.format(cents / 100);
}

/** A calendar day (YYYY-MM-DD) as "Oct 14". The day is a date, not an instant, so it is read in UTC. */
export function formatShortDay(ymd: string): string | null {
  const instant = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(instant) ? null : shortDateFormat.format(new Date(instant));
}

/** A US number as "(402) 555-0144"; any other number as it was given. The link behind it keeps the full +1 form. */
export function formatPhone(number: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number.replace(/[\s().-]/g, ''));
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : number;
}
