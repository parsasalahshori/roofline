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

/*
 * Courtesy words a STOP phrase may come wrapped in (I2a): "Please take me off your list", "no more
 * texts please", "dont text me anymore". Stripped from the ends, as often as they repeat, for the
 * STOP lookup only. A START or HELP must still be the bare keyword.
 */
const LEADING_COURTESY: ReadonlySet<string> = new Set(['please', 'pls', 'plz']);
const TRAILING_COURTESY: ReadonlySet<string> = new Set(['please', 'pls', 'plz', 'thanks', 'thx', 'again', 'anymore']);

/**
 * Words and phrases that make a message worth a person's look, whatever else it says (I2b). Each
 * word may be inflected ("stopped", "cancelling", "texting me", "opted out"), except the short
 * function words in `EXACT_WORDS`. Written in their base forms: "no more text" also covers "no more
 * texts" and "no more texting".
 */
const OPT_OUT_PHRASES = [
  'stop',
  'unsubscribe',
  'quit',
  'end',
  'revoke',
  'cancel',
  'optout',
  'opt out',
  'remove me',
  'remove my number',
  'take me off',
  'text me',
  'contact me',
  'message me',
  'no more text',
  'no more message',
  'leave me alone',
  'delete me',
] as const;

/** Words of `OPT_OUT_PHRASES` that only ever match as they are: "me" must not match "meat". */
const EXACT_WORDS: ReadonlySet<string> = new Set(['me', 'my', 'off', 'out', 'no', 'more', 'alone']);

/**
 * A word and its usual inflections, as a regex fragment: the word, with its last letter doubled
 * ("stopp", "cancell") or its final e dropped ("remov"), then optionally s, es, d, ed, ing, er or
 * ers. So "stop" matches stops, stopped, stopping; "quit" does not match "quite", and "cancel" does
 * not match "cancellation". The words are a-z only, so nothing needs escaping.
 */
function inflected(word: string): string {
  if (EXACT_WORDS.has(word)) return word;
  const stems = new Set([word, word + word.at(-1), word.endsWith('e') ? word.slice(0, -1) : word]);
  return `(?:${[...stems].join('|')})(?:s|es|d|ed|ing|er|ers)?`;
}

/**
 * One phrase of `OPT_OUT_PHRASES` anywhere in a normalized message, on word boundaries. Every
 * alternative is a short fixed sequence of literal words with bounded optional suffixes (no nested
 * repetition), so the search stays linear in the length of the message.
 */
const OPT_OUT_PATTERN = new RegExp(
  `(?:^| )(?:${OPT_OUT_PHRASES.map((phrase) => phrase.split(' ').map(inflected).join(' ')).join('|')})(?= |$)`,
);

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

/**
 * The message without the courtesy words at its ends: a leading please / pls / plz and a trailing
 * please / pls / plz / thanks / thank you / thx / again / anymore, each as often as they repeat.
 * "please dont text me anymore" is "dont text me". Index-based, so it is linear however many there are.
 */
function withoutCourtesy(text: string): string {
  if (text === '') return text;
  const w = text.split(' ');
  let start = 0;
  let end = w.length;
  while (start < end && LEADING_COURTESY.has(w[start]!)) start += 1;
  for (;;) {
    if (end > start && TRAILING_COURTESY.has(w[end - 1]!)) end -= 1;
    else if (end - 1 > start && w[end - 2] === 'thank' && w[end - 1] === 'you') end -= 2;
    else break;
  }
  return w.slice(start, end).join(' ');
}

/** A STOP phrase, as it is or once its courtesy words are taken off (`withoutCourtesy`). */
const isStop = (text: string): boolean => STOP.has(text) || STOP.has(withoutCourtesy(text));

/** Any digit, of any script, in the message as sent or once NFKC has folded it ("９", "²", "①"). */
function hasDigit(body: string): boolean {
  return /\p{N}/u.test(body) || /\p{N}/u.test(body.normalize('NFKC'));
}

/** What an inbound text asks for, and the keyword or phrase it matched (normalized); none for `other`. */
export type InboundReading = { kind: Exclude<InboundKind, 'other'>; keyword: string } | { kind: 'other'; keyword: null };

/**
 * Sorts an inbound text into STOP, HELP, START, or anything else, and gives the message as
 * normalized when it is one of the first three ("Don't text me AGAIN!!" is `dont text me again`):
 * what the opt-out list records as the customer's own words.
 *
 * The match is on the WHOLE message, after normalizing it: "Stop.", "  STOP  " and "don't text me"
 * count, but "Can you stop by Thursday?" does not, because only a message that is nothing but a
 * keyword or a listed phrase counts. Words that merely appear in a longer message never match.
 * A word repeated straight after itself counts once, so "STOP STOP STOP" is a STOP, and for STOP
 * only, courtesy words at the ends are ignored (`withoutCourtesy`): "Please take me off your list"
 * and "no more texts please" are STOPs, while "please start" is not a START.
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
  if (isStop(folded)) return { kind: 'stop', keyword: folded };
  if (isStop(plain)) return { kind: 'stop', keyword: plain };
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
 * has one of `OPT_OUT_PHRASES` (stop, unsubscribe, quit, end, revoke, cancel, optout, opt out,
 * remove me, remove my number, take me off, text me, contact me, message me, no more texts, no
 * more messages, leave me alone, delete me) as whole words, inflected or not, in either reading
 * (`readings`). It leans wide on purpose: "Can you stop by Thursday?" and "cancel my appointment"
 * count; "unstoppable", "quite" and "the weekend" do not.
 *
 * This only flags a message for a person to look at. It never opts anyone out: only
 * `classifyInbound` returning `stop` does that.
 */
export function looksLikeOptOut(body: string): boolean {
  if (typeof body !== 'string') return false;
  const { plain, folded } = readings(body);
  return OPT_OUT_PATTERN.test(plain) || OPT_OUT_PATTERN.test(folded);
}
