import { type GateRule, isTimeZone } from '@roofline/shared';
import { nextAllowedTime } from './quiet-hours.ts';

/** Everything `decideEmail` needs, already fetched: the gate touches no database and no network. */
export type EmailGateRequest = {
  /** Marketing is the stricter case: anything other than 'informational' is treated as marketing. */
  purpose: 'marketing' | 'informational';
  /** Only an exact `true` lets email go out. */
  billingOk: boolean;
  email: string | null;
  /** Only an exact `false` clears this flag: a missing value fails closed. */
  doNotContact: boolean;
  /** Only an exact `false` clears this flag: a missing value fails closed. */
  optedOut: boolean;
  /** The subject as it will be sent. */
  subject: string;
  /** The body as it will be sent: `{company}` and the like already filled in, `{unsubscribe}` or the rendered `/u/` link included. */
  body: string;
  companyName: string;
  companyAddress: string | null;
  /** Only an exact `false` means no earlier send matches this message. */
  dedupeHit: boolean;
  /** Marketing emails sent to this address in the last 7 days. */
  sentLast7Days: number;
  now: Date;
  /** The zone whose 08:00 to 21:00 window applies to this email. */
  timeZone: string;
};

export type EmailGateDecision = { ok: true; sendAt: Date } | { ok: false; rule: GateRule; reason: string };

/** Marketing email may reach one address at most this many times in 7 days. */
const MARKETING_WEEKLY_LIMIT = 2;

/** Shown when a marketing email lacks the company name, the postal address or an unsubscribe link. */
const MISSING_ITEMS_MESSAGE = 'Emails need the company name, mailing address and unsubscribe link.';

/** Shown when a marketing subject or body still holds a storm token that was never filled in. */
const BLANK_MESSAGE = 'This message still has a blank to fill in.';

/** A storm token left unfilled. `{unsubscribe}` is not listed: the send pipeline swaps it for the link. */
const UNFILLED_TOKEN = /\{(first_name|company|hail_size|street|day|company_address)\}/;

/**
 * Characters that take no space on a screen and that `trim()` keeps: the zero-width space,
 * non-joiner and joiner (U+200B to U+200D), the word joiner (U+2060) and the byte-order mark (U+FEFF).
 */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

/** True when nothing would show on screen: only whitespace and zero-width characters, or not a string at all. */
function isBlank(text: unknown): boolean {
  return typeof text !== 'string' || text.replace(ZERO_WIDTH, '').trim() === '';
}

const no = (rule: GateRule, reason: string): EmailGateDecision => ({ ok: false, rule, reason });

/**
 * Whether this email may go out now, later, or never. Pure: the caller supplies the clock and the
 * history, and acts on the answer.
 *
 * The rules run in order and the first block wins: billing, contact (address, then the two
 * opt-out flags), content (a blank subject or body, then for marketing the company name, a mailing
 * address that appears in the body, an unsubscribe link, and no unfilled storm token such as
 * `{street}`), dedupe, and the weekly marketing cap. Then quiet hours: the
 * email is sent at the earliest moment inside 08:00 to 21:00 in `timeZone`. Informational email
 * skips the marketing content and frequency checks but still waits for quiet hours.
 *
 * Throws a RangeError if `now` is not a valid date or `timeZone` is not a known zone, rather than
 * guess. That check runs at the quiet-hours step, after the rules above have had their say.
 */
export function decideEmail(r: EmailGateRequest): EmailGateDecision {
  const informational = r.purpose === 'informational';

  if (r.billingOk !== true) {
    return no('billing', 'Email is paused until billing is sorted out.');
  }

  if (isBlank(r.email)) {
    return no('contact', 'No email address on file.');
  }
  if (r.doNotContact !== false) {
    return no('contact', 'This customer asked not to be emailed.');
  }
  if (r.optedOut !== false) {
    return no('contact', 'They unsubscribed from emails.');
  }

  if (isBlank(r.subject) || isBlank(r.body)) {
    return no('content', 'This message is empty.');
  }
  if (!informational) {
    const address = typeof r.companyAddress === 'string' ? r.companyAddress.trim() : '';
    if (isBlank(r.companyAddress) || address === '') {
      return no('content', MISSING_ITEMS_MESSAGE);
    }
    const name = typeof r.companyName === 'string' ? r.companyName.trim().toLowerCase() : '';
    const body = r.body.toLowerCase();
    if (
      name === '' ||
      !body.includes(name) ||
      !r.body.includes(address) ||
      !(body.includes('{unsubscribe}') || body.includes('/u/'))
    ) {
      return no('content', MISSING_ITEMS_MESSAGE);
    }
    if (UNFILLED_TOKEN.test(r.subject) || UNFILLED_TOKEN.test(r.body)) {
      return no('content', BLANK_MESSAGE);
    }
  }

  if (r.dedupeHit !== false) {
    return no('dedupe', 'Already emailed about this.');
  }

  // Written as "not under the cap" so a NaN count blocks instead of letting everything through.
  if (!informational && !(r.sentLast7Days < MARKETING_WEEKLY_LIMIT)) {
    return no('frequency', 'Already got 2 emails this week.');
  }

  if (Number.isNaN(r.now.getTime())) throw new RangeError('decideEmail: "now" is not a valid date');
  if (!isTimeZone(r.timeZone)) throw new RangeError(`decideEmail: unknown time zone "${r.timeZone}"`);

  const sendAt = nextAllowedTime(r.now, r.timeZone, null);
  return { ok: true, sendAt };
}
