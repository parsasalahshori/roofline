/** Escapes the characters LIKE treats as wildcards, so a search for `100%` finds "100%". */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
