import { SmokeRefused } from './guards.ts';

/** Pure guards for the estimator smoke run. No network, no database; the script imports them. */

export const CONFIRM_PROVIDERS_FLAG = '--confirm-real-providers';

const USAGE =
  'Usage: smoke:estimator --confirm-real-providers [--eagleview-sandbox] [--r2] [--sms <E.164>] [--place-order]';

const E164 = /^\+[1-9]\d{7,14}$/;

export type EstimatorArgs = {
  /** --eagleview-sandbox: token, Property Data, PriceOrder. */
  eagleview: boolean;
  /** --r2: put, get, delete of a test object. */
  r2: boolean;
  /** --sms <E.164>: the test phone, or null when the flag is absent. */
  sms: string | null;
  /** --place-order: real PlaceOrder (sandbox only). */
  placeOrder: boolean;
};

export function assertConfirmedProviders(argv: readonly string[]): void {
  if (!argv.includes(CONFIRM_PROVIDERS_FLAG)) {
    throw new SmokeRefused(
      'This calls real providers and can cost money or send a real text. Pass --confirm-real-providers if you mean it.',
    );
  }
}

export function parseEstimatorArgs(argv: readonly string[]): EstimatorArgs {
  const seen = new Set<string>();
  const args: EstimatorArgs = { eagleview: false, r2: false, sms: null, placeOrder: false };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === CONFIRM_PROVIDERS_FLAG || token === '--eagleview-sandbox' || token === '--r2' || token === '--place-order') {
      if (seen.has(token)) throw new SmokeRefused(USAGE);
      seen.add(token);
      if (token === '--eagleview-sandbox') args.eagleview = true;
      else if (token === '--r2') args.r2 = true;
      else if (token === '--place-order') args.placeOrder = true;
      continue;
    }
    if (token === '--sms') {
      if (seen.has(token)) throw new SmokeRefused(USAGE);
      seen.add(token);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new SmokeRefused(USAGE);
      if (!E164.test(value)) {
        throw new SmokeRefused('The --sms number must be in E.164 form, like +14025550123.');
      }
      args.sms = value;
      i++;
      continue;
    }
    throw new SmokeRefused(USAGE);
  }

  if (!args.eagleview && !args.r2 && args.sms === null) {
    throw new SmokeRefused('Pick at least one check: --eagleview-sandbox, --r2 or --sms <E.164>.');
  }
  if (args.placeOrder && !args.eagleview) {
    throw new SmokeRefused('--place-order needs --eagleview-sandbox.');
  }
  return args;
}

export function assertPlaceOrderAllowed(args: EstimatorArgs, env: Record<string, string | undefined>): void {
  if (args.eagleview && env.EAGLEVIEW_ENV === 'production') {
    throw new SmokeRefused('The smoke run only uses the EagleView sandbox.');
  }
  if (!args.placeOrder) return;
  if (env.EAGLEVIEW_ENV !== 'sandbox') {
    throw new SmokeRefused(
      'PlaceOrder is only allowed against the EagleView sandbox. Set EAGLEVIEW_ENV=sandbox.',
    );
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/** Names of the env keys the chosen checks need and the env lacks. Never values. */
export function missingEstimatorConfig(args: EstimatorArgs, env: Record<string, string | undefined>): string[] {
  const needed: string[] = [];
  if (args.eagleview) {
    needed.push('EAGLEVIEW_CLIENT_ID', 'EAGLEVIEW_CLIENT_SECRET', 'EAGLEVIEW_PRODUCT_ID');
  }
  if (args.r2) {
    needed.push('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET');
  }
  if (args.sms !== null) {
    needed.push(
      'DATABASE_URL_TENANT',
      'ENCRYPTION_KEY',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'SMOKE_COMPANY_ID',
      'SMOKE_PROPOSAL_ID',
    );
  }

  const missing: string[] = [];
  for (const key of new Set(needed)) {
    const value = env[key];
    if (isBlank(value)) {
      missing.push(key);
      continue;
    }
    if (key === 'EAGLEVIEW_PRODUCT_ID') {
      const trimmed = (value as string).trim();
      if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) missing.push(key);
    }
  }
  return missing;
}

export function assertEstimatorConfig(args: EstimatorArgs, env: Record<string, string | undefined>): void {
  const missing = missingEstimatorConfig(args, env);
  if (missing.length > 0) {
    throw new SmokeRefused(`Set these first: ${missing.join(', ')}.`);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces every occurrence of each non-empty secret with [hidden]. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  const usable = [...new Set(secrets.filter((s): s is string => s !== undefined && s.length >= 4))];
  if (usable.length === 0) return text;
  // One pass over the alternation, longest first, so a replacement never gets re-scanned.
  usable.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(usable.map(escapeRegExp).join('|'), 'g');
  return text.replace(pattern, '[hidden]');
}

/** '+14025550123' -> '+1402***0123'. */
export function maskPhone(e164: string): string {
  if (e164.length < 10) return '***';
  return `${e164.slice(0, 5)}***${e164.slice(-4)}`;
}
