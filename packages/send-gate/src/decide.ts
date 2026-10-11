import { DateTime } from 'luxon';
import { type CampaignStatus, type CompanyStatus, type ConsentStatus, type GateRule, isTimeZone, type MessagePurpose, textability } from '@roofline/shared';
import { isStrictState, nextAllowedTime } from './quiet-hours.ts';

/** Everything `decide` needs, already fetched: the gate itself touches no database and no network. */
export type GateRequest = {
  now: Date;
  company: {
    name: string;
    /** The company's own IANA zone: where "their time" comes from when the customer has none. */
    timezone: string;
    status: CompanyStatus;
    campaignStatus: CampaignStatus;
    marketingCapPer7d: number;
  };
  recipient: {
    phoneE164: string | null;
    consent: ConsentStatus;
    doNotContact: boolean;
    optedOut: boolean;
    timezone: string | null;
    state: string | null;
  };
  message: {
    purpose: MessagePurpose;
    /** The body as it will be sent: `{company}` and `{first_name}` already filled in. */
    body: string;
    dedupeKey: string | null;
    /** When the customer's text we are answering arrived, if this message is a reply. */
    replyToInboundAt: Date | null;
  };
  history: {
    dedupeAlreadySent: boolean;
    /**
     * When marketing texts to this customer went out, any order. Older than 7 days is ignored. An
     * invalid Date (a send whose time is unknown) counts as having just gone out.
     */
    marketingSentAt: Date[];
  };
};

export type GateDecision =
  | { action: 'send' }
  | { action: 'schedule'; at: Date; rule: GateRule; reason: string }
  | { action: 'block'; rule: GateRule; reason: string };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** An informational text answering a customer's text from within this long ago ignores quiet hours. */
const REPLY_WINDOW_MS = 15 * MINUTE_MS;
/** FL, OK and MD allow this many marketing texts to one person in any 24 hours. */
const STRICT_STATE_DAILY_LIMIT = 3;

// Allow-lists, not deny-lists: a status or consent value this code has not heard of fails closed.
const SENDING_STATUSES: ReadonlySet<CompanyStatus> = new Set(['trial', 'active']);
const MARKETING_CONSENT: ReadonlySet<ConsentStatus> = new Set(['attested', 'written']);
const INFORMATIONAL_CONSENT: ReadonlySet<ConsentStatus> = new Set(['express', 'attested', 'written']);

const OPT_OUT_PHRASE = /reply stop to opt out/i;

/**
 * Characters that take no space on a phone screen and that `trim()` keeps: the zero-width space,
 * non-joiner and joiner (U+200B to U+200D) and the word joiner (U+2060). The byte-order mark
 * (U+FEFF) is listed too, although `trim()` already drops it.
 */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

/** True when nothing would show on screen: only whitespace and zero-width characters, or no text. */
function isBlank(body: unknown): boolean {
  return typeof body !== 'string' || body.replace(ZERO_WIDTH, '').trim() === '';
}

const block = (rule: GateRule, reason: string): GateDecision => ({ action: 'block', rule, reason });

/** Marketing must name the company and say how to opt out. The body is the one actually sent. */
function marketingContentOk(body: string, companyName: string): boolean {
  const name = companyName.trim().toLowerCase();
  return name !== '' && body.toLowerCase().includes(name) && OPT_OUT_PHRASE.test(body);
}

/**
 * Whether this text may go out now, later, or never. Pure: the caller supplies the clock and the
 * history, and acts on the answer.
 *
 * The rules run in order and the first block wins: billing, registration, contact, consent,
 * content (a blank body, then the marketing wording), dedupe, the weekly cap. The contact rule also
 * checks that the number can be texted: a US number that is not toll-free. Then two things can
 * push the send into the future: the 3-per-24-hours limit (marketing to FL, OK and MD) and quiet
 * hours (08:00 to 21:00 their time, 20:00 in those states). The send waits for whichever is later;
 * the rule reported is `frequency` if the daily limit is what is holding it, otherwise
 * `quiet_hours`.
 *
 * Anything that is not plainly informational is treated as marketing, the stricter case.
 *
 * Throws if `now` is not a valid date or no usable time zone is known, rather than guess.
 */
export function decide(req: GateRequest): GateDecision {
  const { now, company, recipient, message, history } = req;
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new RangeError('decide: "now" is not a valid date');
  const informational = message.purpose === 'informational';

  if (!SENDING_STATUSES.has(company.status)) {
    return block('billing', 'Texting is paused until billing is sorted out.');
  }

  if (company.campaignStatus !== 'approved') {
    return block('registration', 'Texting turns on after the phone carriers approve your registration.');
  }

  if (recipient.phoneE164 == null || recipient.phoneE164.trim() === '') {
    return block('contact', 'No mobile number on file.');
  }
  // Only an exact `false` clears these flags: a null or missing value from a database row or a
  // webhook fails closed, like an unknown status does above.
  if (recipient.doNotContact !== false || recipient.optedOut !== false) {
    return block('contact', 'This customer asked not to be texted.');
  }

  // Only an exact 'ok' passes: a number that is toll-free, outside the US, or not a valid number
  // at all is blocked, the same fail-closed way as the flags above.
  const textable = textability(recipient.phoneE164);
  if (textable === 'toll_free') {
    return block('contact', "This is a toll-free number, which can't get these texts.");
  }
  if (textable === 'not_us') {
    return block('contact', "This number is outside the US, so we can't text it.");
  }
  if (textable !== 'ok') {
    return block('contact', "This isn't a mobile number we can text.");
  }

  const allowedConsent = informational ? INFORMATIONAL_CONSENT : MARKETING_CONSENT;
  if (!allowedConsent.has(recipient.consent)) {
    return block('consent', 'No texting consent on file.');
  }

  // The content rule. A blank text is never sent, whatever its purpose; marketing must also carry
  // the company name and the opt-out wording. A body that is not a string, or one with nothing
  // visible in it (whitespace and zero-width characters only), counts as blank.
  if (isBlank(message.body)) {
    return block('content', 'This message is empty.');
  }
  if (!informational && !marketingContentOk(message.body, company.name)) {
    return block('content', 'Marketing texts must include your company name and how to opt out.');
  }

  // Same as the contact flags: not knowing whether it went out is treated as it having gone out.
  if (history.dedupeAlreadySent !== false) {
    return block('dedupe', 'Already sent this message to this customer.');
  }

  // Marketing sends in the last 7 days, whatever order the caller listed them in. A send stamped a
  // moment after `now` (another worker got there first) still counts: over-counting only delays.
  // A send with an invalid timestamp is read as having just happened: inside both the 7-day and
  // the 24-hour window, and the last to age out. Dropping it would under-count and let a text
  // through that the cap forbids.
  const sentMs = history.marketingSentAt.map((d) => {
    const ms = d.getTime();
    return Number.isNaN(ms) ? nowMs : ms;
  });
  const lastWeek = sentMs.filter((ms) => nowMs - ms <= 7 * DAY_MS);
  // Written as "not under the cap" so a cap that is NaN blocks instead of letting everything through.
  if (!informational && !(lastWeek.length < company.marketingCapPer7d)) {
    return block('frequency', 'Already texted this customer the most allowed this week.');
  }

  // Earliest the daily limit allows. Sorted newest first, the third entry is the one that has to
  // age out to leave only two inside the 24 hours, however many more there are.
  let earliestMs = nowMs;
  if (!informational && isStrictState(recipient.state)) {
    const lastDay = lastWeek.filter((ms) => nowMs - ms <= DAY_MS).sort((a, b) => b - a);
    if (lastDay.length >= STRICT_STATE_DAILY_LIMIT) {
      earliestMs = lastDay[STRICT_STATE_DAILY_LIMIT - 1] + DAY_MS;
    }
  }

  // Their own zone if it is a real one, else the company's; a bad value is not guessed at.
  const zone = [recipient.timezone, company.timezone].find((z): z is string => z != null && isTimeZone(z));
  if (zone === undefined) {
    throw new RangeError('decide: no valid time zone for the recipient or the company');
  }

  // A reply to a customer who texted in the last 15 minutes is a conversation, not an interruption.
  // An inbound time after `now` is clock skew or bad data, and does not count.
  const replyMs = message.replyToInboundAt?.getTime();
  const answeringNow =
    informational && replyMs !== undefined && replyMs <= nowMs && nowMs - replyMs <= REPLY_WINDOW_MS;

  const sendAtMs = answeringNow
    ? earliestMs
    : nextAllowedTime(new Date(earliestMs), zone, recipient.state).getTime();

  if (sendAtMs <= nowMs) return { action: 'send' };

  const rule: GateRule = earliestMs > nowMs ? 'frequency' : 'quiet_hours';
  const at = new Date(sendAtMs);
  // en-US pinned so "8:00 AM" does not depend on the server's locale.
  const theirTime = DateTime.fromJSDate(at, { zone }).setLocale('en-US').toFormat('h:mm a');
  const why = rule === 'frequency' ? 'daily limit' : 'quiet hours';
  return { action: 'schedule', at, rule, reason: `Will send at ${theirTime} their time (${why}).` };
}
