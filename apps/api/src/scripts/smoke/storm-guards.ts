import { SmokeRefused } from './guards.ts';

export { SmokeRefused };

export const STORM_CONFIRM_FLAG = '--confirm-real-providers';
/** The only budget a non-test Google account may be given under --i-understand-spend: $1. */
export const SMOKE_BUDGET_CENTS = 100;

export type StormSmokeArgs = {
  google: string | null;
  meta: string | null;
  email: string | null;
  understandSpend: boolean;
};

const SCRUBBED = '[scrubbed]';
const SECRET_KEY = /token|secret|authorization|key|password|email|phone|name|address|customer_?id|account_?id|resource_?name/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_LIKE = /^(Bearer\s+)?[A-Za-z0-9._-]{32,}$/;

export function assertStormConfirmed(argv: readonly string[]): void {
  if (!argv.includes(STORM_CONFIRM_FLAG)) {
    throw new SmokeRefused(
      'This calls the real MESH feed, Google Ads, Meta and Postmark test accounts and sends one real email. Pass --confirm-real-providers if you mean it.',
    );
  }
}

/** Reads the value that follows a value flag. The error names the flag, never the value. */
function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new SmokeRefused(`The ${flag} flag needs a value.`);
  }
  return next;
}

export function parseStormArgs(argv: readonly string[]): StormSmokeArgs {
  const out: StormSmokeArgs = { google: null, meta: null, email: null, understandSpend: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--google') {
      const digits = valueAfter(argv, i, '--google').replace(/[-\s]/g, '');
      if (!/^\d{10}$/.test(digits)) {
        throw new SmokeRefused('The --google value must be a 10-digit Google Ads customer id.');
      }
      out.google = digits;
      i++;
    } else if (arg === '--meta') {
      const raw = valueAfter(argv, i, '--meta');
      const match = /^(?:act_)?(\d{1,20})$/.exec(raw);
      if (match === null) {
        throw new SmokeRefused('The --meta value must be a Meta ad account id such as act_123.');
      }
      out.meta = `act_${match[1]}`;
      i++;
    } else if (arg === '--email') {
      const raw = valueAfter(argv, i, '--email');
      if (!EMAIL_FORMAT.test(raw)) {
        throw new SmokeRefused('The --email value must be an email address.');
      }
      out.email = raw;
      i++;
    } else if (arg === '--i-understand-spend') {
      out.understandSpend = true;
    }
  }
  return out;
}

export function parseGoogleTestAccount(rows: readonly Record<string, unknown>[]): boolean {
  if (!Array.isArray(rows)) return false;
  const first = rows[0] as unknown;
  if (typeof first !== 'object' || first === null) return false;
  const customer = (first as Record<string, unknown>).customer as unknown;
  if (typeof customer !== 'object' || customer === null) return false;
  const c = customer as Record<string, unknown>;
  return c.testAccount === true || c.test_account === true;
}

export function assertGoogleSmokeAllowed(i: {
  isTestAccount: boolean;
  understandSpend: boolean;
  dailyBudgetCents: number;
}): void {
  if (i.isTestAccount) return;
  if (i.understandSpend && i.dailyBudgetCents === SMOKE_BUDGET_CENTS) return;
  throw new SmokeRefused(
    'This Google Ads account is not a test account. Use a test account, or pass --i-understand-spend, which allows one paused campaign with a $1 budget that is removed straight away.',
  );
}

export function smokeNameTag(platform: 'google' | 'meta', stamp: string): string {
  return `Roofline smoke ${platform} ${stamp}`;
}

export function assertUnsubscribeLink(mail: { text: string; html: string; unsubscribeUrl: string }, appOrigin: string): void {
  const prefix = `${appOrigin}/u/`;
  const ok =
    mail.unsubscribeUrl.startsWith(prefix) &&
    mail.unsubscribeUrl.length > prefix.length &&
    mail.text.includes(mail.unsubscribeUrl) &&
    mail.html.includes(mail.unsubscribeUrl);
  if (!ok) {
    throw new SmokeRefused('The broadcast email has no working unsubscribe link, so it was not sent.');
  }
}

/** Deep copies a fixture, replacing secret-looking keys, email-looking strings and token-looking strings. */
export function scrubFixture(value: unknown): unknown {
  if (typeof value === 'string') {
    return EMAIL_LIKE.test(value) || TOKEN_LIKE.test(value) ? SCRUBBED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubFixture(item));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? SCRUBBED : scrubFixture(item);
    }
    return out;
  }
  return value;
}
