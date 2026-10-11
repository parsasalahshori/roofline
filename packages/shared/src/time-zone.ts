/**
 * The place names ICU knows (`America/Chicago`, `Europe/Berlin`), read once at module load, plus
 * `UTC`, which `supportedValuesOf` leaves out. ICU lists its own older spellings of a few zones
 * (`America/Indianapolis`, `Asia/Calcutta`), which is why `isTimeZone` also resolves aliases.
 */
const KNOWN_ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

/**
 * True for a real zone name such as `America/Chicago`, and for another name for one such as
 * `America/Indiana/Indianapolis` or `US/Central`. False for everything else: fixed offsets
 * (`-06:00`, `+0500`, `+05`, `Etc/GMT+5`), which have no daylight saving and name no place;
 * keywords such as `local`; and text that is not a zone at all. A customer's zone must be a place,
 * so a fixed offset must never stand in for it.
 *
 * Only a name with a `/` is looked up as an alias, and it counts only if it resolves to a zone in
 * the known list. The check runs against the text exactly as given (no trimming).
 *
 * This is the one zone check: the API validates company and property zones with it, and the send
 * gate uses it before it trusts a recipient's zone.
 */
export function isTimeZone(zone: string): boolean {
  if (typeof zone !== 'string') return false;
  if (KNOWN_ZONES.has(zone)) return true;
  if (!zone.includes('/')) return false;
  try {
    return KNOWN_ZONES.has(new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone);
  } catch {
    return false; // Intl throws a RangeError for a name it does not know
  }
}
