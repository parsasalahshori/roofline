/** What an inbound text asks of us, by keyword. `other` is every message that is not one of the keywords. */
export type InboundKind = 'stop' | 'help' | 'start' | 'other';

// Compared against the normalized message: lower-case letters a-z and single spaces only, so
// "don't" is written "dont". Whole message only, so these are looked up, never searched for.
//
// Texting law lets a customer take back consent by any reasonable means, so the list leans wide:
// a phrase that only ever means "stop texting me" belongs here (R22). A phrase that can also mean
// something else ("stop now", "quit it", "cancel my appointment") does not; `looksLikeOptOut`
// flags those for a person instead.
const STOP: ReadonlySet<string> = new Set([
  'stop',
  'stopall',
  'stop all',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'revoke',
  'optout',
  'opt out',
  // Phrases people write instead of the bare keyword.
  'stop please',
  'stop it',
  'stop sending',
  'stop texting',
  'stop texting me',
  'stop texting me please',
  'stop messaging me',
  'please stop',
  'please stop texting',
  'please stop texting me',
  'please stop messaging me',
  'unsubscribe me',
  'unsubscribe please',
  'unsubscribe me please',
  'remove me',
  'please remove me',
  'remove me from the list',
  'take me off the list',
  'take me off your list',
  'take me off of your list',
  'do not text me',
  'dont text me',
  'dont text me again',
  'do not contact me',
  'dont contact me',
  'dont message me',
  'quit texting me',
  'no more texts',
  'opt me out',
]);
const HELP: ReadonlySet<string> = new Set(['help', 'info']);
const START: ReadonlySet<string> = new Set(['start', 'unstop', 'yes start']);

/** Words (or word pairs) that make a message worth a person's look, whatever else it says. */
const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'remove me', 'opt out', 'optout'] as const;

/**
 * A non-ASCII character whose lower-case form contains an ASCII letter: the KELVIN SIGN (U+212A,
 * "k") and "İ" (U+0130, "i" plus a combining dot). NFKC would also turn the Kelvin sign into "K".
 * These are dropped before anything else runs, so neither can ever become the ASCII letter.
 */
function dropAsciiLookalikes(body: string): string {
  return body.replace(/[\u0080-\u{10FFFF}]/gu, (ch) => (/[a-z]/.test(ch.toLowerCase()) ? '' : ch));
}

/**
 * The words of a message: lower-case a-z and single spaces. Every run of whitespace becomes one
 * space; everything that is not a letter or a space is dropped; it is lower-cased; ends trimmed;
 * and a word repeated straight after itself counts once ("stop stop stop" is "stop"). "Letters"
 * means a-z and A-Z only: accented letters, other scripts, digits, punctuation (curly apostrophes
 * included) and emoji all count as non-letters and are stripped, so "STÖP" becomes "stp", which is
 * nothing we know. The strip runs before the lower-case so no character can fold into an ASCII
 * letter on the way.
 *
 * Every pattern is a single character class or a plain run of one character, and the word pass is
 * one split, so the work is linear in the length of the message however long or odd it is.
 */
function words(text: string): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z ]/g, '')
    .toLowerCase()
    .replace(/ {2,}/g, ' ')
    .trim();
  if (flat === '') return '';
  const out: string[] = [];
  for (const word of flat.split(' ')) {
    if (word !== out[out.length - 1]) out.push(word);
  }
  return out.join(' ');
}

/**
 * The message read two ways (R22):
 * - `plain`: as it was sent. Only ASCII letters count.
 * - `folded`: after NFKC, so compatibility forms of the letters count as the letters: fullwidth
 *   "ＳＴＯＰ", mathematical "𝐒𝐓𝐎𝐏", the ligature "ﬆ", the long s "ſ". The Kelvin sign and U+0130
 *   are dropped before NFKC (`dropAsciiLookalikes`); everything that is still not a-z after NFKC is
 *   stripped as before.
 */
function readings(body: string): { plain: string; folded: string } {
  return { plain: words(body), folded: words(dropAsciiLookalikes(body).normalize('NFKC')) };
}

/** Any digit, of any script, in the message as sent or once NFKC has folded it ("９", "²", "①"). */
function hasDigit(body: string): boolean {
  return /\p{N}/u.test(body) || /\p{N}/u.test(body.normalize('NFKC'));
}

/** What an inbound text asks for, and the keyword or phrase it matched (normalized); none for `other`. */
export type InboundReading = { kind: Exclude<InboundKind, 'other'>; keyword: string } | { kind: 'other'; keyword: null };

/**
 * Sorts an inbound text into STOP, HELP, START, or anything else, and says which keyword or listed
 * phrase it matched, normalized ("Don't text me AGAIN!!" is `dont text me again`): what the opt-out
 * list records as the customer's own words.
 *
 * The match is on the WHOLE message, after normalizing it: "Stop.", "  STOP  " and "don't text me"
 * count, but "Can you stop by Thursday?" does not, because only a message that is nothing but a
 * keyword or a listed phrase counts. Words that merely appear in a longer message never match.
 * A word repeated straight after itself counts once, so "STOP STOP STOP" is a STOP.
 *
 * Opting out is read as widely as is safe; opting back in, narrowly:
 * - STOP (and HELP) when EITHER reading is one (`readings`): NFKC only ever adds a STOP, never
 *   loses one the plain reading finds ("STOP™" folds to "stoptm", but read plainly it is "stop").
 * - START only when BOTH readings are START and the message has no digit anywhere (`hasDigit`):
 *   it gives consent back, so "Start 9", a fullwidth "ＳＴＡＲＴ" and anything else unusual is
 *   `other`, and the customer stays opted out until they send a plain START.
 *
 * Because digits and punctuation are dropped, "Stop 2" and "STOP!!!" are both just "stop". An empty
 * or blank body, or anything that is not a string, is `other`. There is no length limit: a long
 * message is simply not a keyword, and a keyword padded with a lot of whitespace is still one,
 * since a STOP must be honored.
 */
export function readInbound(body: string): InboundReading {
  if (typeof body !== 'string') return { kind: 'other', keyword: null };
  const { plain, folded } = readings(body);
  if (STOP.has(folded)) return { kind: 'stop', keyword: folded };
  if (STOP.has(plain)) return { kind: 'stop', keyword: plain };
  if (HELP.has(folded)) return { kind: 'help', keyword: folded };
  if (HELP.has(plain)) return { kind: 'help', keyword: plain };
  if (START.has(folded) && START.has(plain) && !hasDigit(body)) return { kind: 'start', keyword: plain };
  return { kind: 'other', keyword: null };
}

/** `readInbound(body).kind`: STOP, HELP, START, or anything else. */
export function classifyInbound(body: string): InboundKind {
  return readInbound(body).kind;
}

/**
 * Whether a message that is not a keyword still reads like someone asking not to be texted: it
 * has the whole word "stop", "unsubscribe" or "optout", or the words "remove me" or "opt out",
 * in either reading (`readings`). "Can you stop by Thursday?" counts; "stopping by at 5" does not.
 *
 * This only flags a message for a person to look at. It never opts anyone out: only
 * `classifyInbound` returning `stop` does that.
 */
export function looksLikeOptOut(body: string): boolean {
  if (typeof body !== 'string') return false;
  const { plain, folded } = readings(body);
  return [plain, folded].some((text) => {
    const padded = ` ${text} `;
    return OPT_OUT_WORDS.some((w) => padded.includes(` ${w} `));
  });
}
