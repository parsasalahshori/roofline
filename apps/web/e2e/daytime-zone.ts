/*
 * A time zone whose wall clock reads between 10:00 and 17:59 at a given moment, so a staff text sent in a Front Desk
 * spec is never held for quiet hours (the send gate opens at 08:00 and closes at 21:00, or at 20:00 in FL, OK and MD).
 *
 * The six US zones cover 14:00 to 03:59 UTC. Tokyo, Dubai and London close the rest of the day, in summer and in
 * winter, so there is a daytime zone at every hour of the year.
 */
const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Asia/Tokyo',
  'Asia/Dubai',
  'Europe/London',
] as const;

const FIRST_HOUR = 10;
const LAST_HOUR = 17;

function hourIn(zone: string, now: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(now));
}

export function daytimeZone(now: Date): string {
  for (const zone of ZONES) {
    const hour = hourIn(zone, now);
    if (hour >= FIRST_HOUR && hour <= LAST_HOUR) return zone;
  }
  // Unreachable while the list covers the day; Chicago is Acme's own zone.
  return 'America/Chicago';
}
