/** Starts with a house number and a word (`12 Elm St`, `3518 Lowell St NW, Washington, DC`): worth looking up as an address. */
export function looksLikeAddress(text: string): boolean {
  const t = text.trim();
  return t.length >= 6 && t.length <= 300 && /^\d+[A-Za-z]?(-\d+)?\s+[A-Za-z0-9]/.test(t) && /[A-Za-z]{2}/.test(t);
}

/**
 * A street address with its town or ZIP (`12 Elm St, Omaha`, `12 Elm St 68102`, `12 Elm St NE`): complete enough to
 * look up before Measure is pressed. A bare `12 Elm` is not (it could land anywhere, and loading that area would be
 * wasted work).
 */
export function looksCompleteAddress(text: string): boolean {
  const t = text.trim();
  return looksLikeAddress(t) && (/,\s*[A-Za-z]{2}/.test(t) || /\b\d{5}\b/.test(t.replace(/^\d+/, '')) || /\s[A-Z]{2}$/.test(t));
}

/** Where the measure window opens to measure a typed address straight away (the shell search's "Measure roof"). */
export function measureAddressHref(address: string): string {
  return `/estimator?measure=${encodeURIComponent(address.trim())}`;
}

/** Where the windows screen opens to measure a typed address straight away (the shell search's "Measure windows"). */
export function measureWindowsHref(address: string): string {
  return `/estimator/windows?measure=${encodeURIComponent(address.trim())}`;
}

/** "305 Ridgeway Dr, Little Rock, AR 72205" as the street ("305 Ridgeway Dr") and the rest ("Little Rock, AR 72205"). */
export function splitAddress(address: string): { street: string; rest: string } {
  const at = address.indexOf(',');
  if (at < 0) return { street: address.trim(), rest: '' };
  return { street: address.slice(0, at).trim(), rest: address.slice(at + 1).trim() };
}
