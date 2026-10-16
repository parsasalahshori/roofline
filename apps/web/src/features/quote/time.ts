/**
 * A visit time in the company's time zone, the zone the visit happens in. The zone's short name (CDT) is added when
 * the viewer's own zone differs, so the list and the confirmation always agree and never shift by the viewer's clock.
 */
export function visitTime(iso: string, zone: string, style: 'short' | 'long', viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const differs = viewerZone !== zone;
  return new Date(iso).toLocaleString('en-US', {
    weekday: style,
    month: style,
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
    ...(differs && { timeZoneName: 'short' }),
  });
}

/** The day of a visit in the company's time zone, as the booking list heads it: "Fri, Oct 16". */
export function visitDay(iso: string, zone: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone });
}

/** The clock time of a visit in the company's time zone: "10:00 AM". */
export function visitClock(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
}

/** The company's zone in words ("Central Daylight Time"), for the line that says what zone the times are in. */
export function zoneName(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' }).formatToParts(new Date(iso)).find((part) => part.type === 'timeZoneName')?.value ?? zone;
}

/** The month and day of a visit for the date tile: "OCT" and "16". */
export function visitTile(iso: string, zone: string): { month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }).formatToParts(new Date(iso));
  return {
    month: (parts.find((part) => part.type === 'month')?.value ?? '').toLocaleUpperCase('en-US'),
    day: parts.find((part) => part.type === 'day')?.value ?? '',
  };
}
