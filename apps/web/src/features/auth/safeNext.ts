/** Tabs, line breaks and the like. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Where to go after signing in. `raw` comes from the address bar, so it can be anything a link
 * can carry, and only a path inside this site is followed:
 * - it starts with a single `/`, which also rules out `https:` and `javascript:` (a `:` before the first `/`);
 * - it is not `//` or `/\`, which a browser reads as another site;
 * - it holds no tab or line break, which a browser deletes from an address, so `/<tab>/evil.example`
 *   would turn into `//evil.example`.
 */
export function safeNext(raw: string | null): string {
  if (raw === null || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return hasControlCharacter(raw) ? '/' : raw;
}
