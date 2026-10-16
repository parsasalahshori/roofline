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
