/** What an inbound text asks of us, by keyword. `other` is every message that is not one of the keywords. */
export type InboundKind = 'stop' | 'help' | 'start' | 'other';

// Compared against the normalized message: lower-case letters a-z and single spaces only, so
// "don't" is written "dont". Whole message only, so these are looked up, never searched for.
const STOP: ReadonlySet<string> = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'revoke',
  'optout',
  'opt out',
  // Phrases people write instead of the bare keyword.
  'stop texting me',
  'stop messaging me',
  'stop texting',
  'please stop',
  'please stop texting me',
  'unsubscribe me',
  'remove me',
  'take me off your list',
  'do not text me',
  'dont text me',
  'opt me out',
]);
const HELP: ReadonlySet<string> = new Set(['help', 'info']);
const START: ReadonlySet<string> = new Set(['start', 'unstop', 'yes start']);

/**
 * Lower-case; every run of whitespace becomes one space; everything that is not a letter or a space
 * is dropped; ends trimmed. "Letters" means a-z and A-Z only: accented letters, other scripts,
 * digits, punctuation (curly apostrophes included) and emoji all count as non-letters and are
 * stripped, so "STÖP" becomes "stp", which is nothing we know. The strip runs before the lower-case
 * so a character such as the Kelvin sign cannot fold into an ASCII letter and slip through.
 *
 * Every pattern is a single character class or a plain run of one character, so the work is linear
 * in the length of the message however long or odd it is.
 */
function normalize(body: string): string {
  return body
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z ]/g, '')
    .toLowerCase()
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Sorts an inbound text into STOP, HELP, START, or anything else.
 *
 * The match is on the WHOLE message, after normalizing it: "Stop.", "  STOP  " and "don't text me"
 * count, but "Can you stop by Thursday?" does not, because only a message that is nothing but a
 * keyword or a listed phrase counts. Words that merely appear in a longer message never match.
 *
 * Because digits and punctuation are dropped, "Stop 2" and "STOP!!!" are both just "stop". An empty
 * or blank body, or anything that is not a string, is `other`. There is no length limit: a long
 * message is simply not a keyword, and a keyword padded with a lot of whitespace is still one,
 * since a STOP must be honored.
 */
export function classifyInbound(body: string): InboundKind {
  if (typeof body !== 'string') return 'other';
  const text = normalize(body);
  if (STOP.has(text)) return 'stop';
  if (HELP.has(text)) return 'help';
  if (START.has(text)) return 'start';
  return 'other';
}
