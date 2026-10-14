/** Starts with a house number and a word (`12 Elm St`, `3518 Lowell St NW, Washington, DC`): worth looking up as an address. */
export function looksLikeAddress(text: string): boolean {
  const t = text.trim();
  return t.length >= 6 && t.length <= 300 && /^\d+[A-Za-z]?(-\d+)?\s+[A-Za-z0-9]/.test(t) && /[A-Za-z]{2}/.test(t);
}

/** Where the measure window opens to measure a typed address straight away (the shell search's "Measure roof"). */
export function measureAddressHref(address: string): string {
  return `/estimator?measure=${encodeURIComponent(address.trim())}`;
}
