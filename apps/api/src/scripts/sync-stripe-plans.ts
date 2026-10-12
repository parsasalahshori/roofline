import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { BillingConfigError, type BillingConfig, parseBillingConfig } from '@roofline/shared';
import {
  applySyncAction,
  describeAction,
  planStripeSync,
  readStripeState,
} from '../billing/stripe-sync.ts';
import { loadConfigOrExit } from '../deps.ts';
import { BillingUnavailableError } from '../providers/billing.ts';

/*
 * Makes Stripe match the billing plan file (BILLING_PLANS_FILE):
 *
 *   npm run sync:stripe-plans -w @roofline/api -- [--dry-run] [--live]
 *
 * It prints one plain line per change: the change is made unless --dry-run is passed. Old prices
 * are never archived. A live key (sk_live_) needs --live. Provider error text is never printed:
 * a failure prints a plain sentence and exits 1.
 */

export const USAGE = 'Usage: npm run sync:stripe-plans -w @roofline/api -- [--dry-run] [--live]';

const REFUSED = 'Stripe refused the request.';
const ALLOWED_FLAGS = new Set(['--dry-run', '--live']);

export type SyncIo = { log(line: string): void; error(line: string): void };

const consoleIo: SyncIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Runs the sync and returns the exit code (0 when done, 1 when refused or stopped). */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: SyncIo = consoleIo,
): Promise<number> {
  if (argv.some((arg) => !ALLOWED_FLAGS.has(arg))) {
    io.error(USAGE);
    return 1;
  }
  const dryRun = argv.includes('--dry-run');
  const live = argv.includes('--live');

  const config = loadConfigOrExit(env);

  const key = config.STRIPE_SECRET_KEY;
  if (!key) {
    io.error('Set STRIPE_SECRET_KEY first.');
    return 1;
  }
  if (key.startsWith('sk_live_') && !live) {
    io.error('This is a live key. Pass --live if you mean it.');
    return 1;
  }

  const planFile = config.BILLING_PLANS_FILE;
  if (!planFile) {
    io.error('Set BILLING_PLANS_FILE first.');
    return 1;
  }
  let plans: BillingConfig;
  try {
    plans = parseBillingConfig(JSON.parse(readFileSync(planFile, 'utf8')));
  } catch (err) {
    if (err instanceof BillingConfigError) io.error(err.message);
    else if (err instanceof SyntaxError) io.error(`${planFile} is not valid JSON.`);
    else io.error(`${planFile} could not be read.`);
    return 1;
  }

  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient(fetch), maxNetworkRetries: 2 });

  try {
    const state = await readStripeState(stripe);
    const actions = planStripeSync(plans, state);
    if (actions.length === 0) {
      io.log('Stripe matches the plan file.');
      return 0;
    }
    for (const action of actions) {
      io.log(dryRun ? describeAction(action) : await applySyncAction(stripe, action, state));
    }
    return 0;
  } catch (err) {
    io.error(err instanceof BillingUnavailableError ? err.message : REFUSED);
    return 1;
  }
}

/** True when this file is the script being run (`tsx src/scripts/sync-stripe-plans.ts`), not a module a test imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
