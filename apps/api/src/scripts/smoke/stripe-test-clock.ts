import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { METER_EVENT_NAME, priceLookupKeys } from '@roofline/shared';
import { loadConfigOrExit } from '../../deps.ts';
import { SmokeRefused, assertStripeTestKey } from './guards.ts';

/*
 * Runs one starter-plan company through a Stripe test clock: trial, meter events, an exact-report
 * invoice item, then 15 days forward so the invoice is produced:
 *
 *   npm run smoke:stripe -w @roofline/api
 *
 * Run it by hand only, with a Stripe TEST key (sk_test_) in STRIPE_SECRET_KEY. Run
 * sync:stripe-plans first so the starter prices exist. Nothing here is run by CI or the unit suite.
 * The key and provider error text are never printed.
 */

const TRIAL_SECONDS = 14 * 86400;
const ADVANCE_SECONDS = 15 * 86400;
const POLL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

export type SmokeIo = { log(line: string): void; error(line: string): void };

const consoleIo: SmokeIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const STOPPED = 'The Stripe run stopped. Check the test key and that sync:stripe-plans has been run.';

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs the smoke flow and returns the exit code (0 when done, 1 when refused or stopped). */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: SmokeIo = consoleIo,
): Promise<number> {
  void argv;
  const config = loadConfigOrExit(env);

  let key: string;
  try {
    key = assertStripeTestKey(config.STRIPE_SECRET_KEY);
  } catch (err) {
    if (err instanceof SmokeRefused) io.error(err.message);
    else io.error(STOPPED);
    return 1;
  }

  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient(fetch), maxNetworkRetries: 2 });

  try {
    io.log('1. Creating a test clock and a customer on it.');
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1000),
    });
    const clockTime = clock.frozen_time;
    const customer = await stripe.customers.create({
      test_clock: clock.id,
      payment_method: 'pm_card_visa',
      invoice_settings: { default_payment_method: 'pm_card_visa' },
    });

    io.log('2. Subscribing to the starter prices with a 14-day trial.');
    const keys = priceLookupKeys('starter');
    const lookupKeys = [keys.monthly, keys.ai_call_minute, keys.sms_segment];
    const prices = await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 10 });
    const priceByKey = new Map(prices.data.map((price) => [price.lookup_key, price.id]));
    if (lookupKeys.some((lookupKey) => !priceByKey.has(lookupKey))) {
      io.error('Run sync:stripe-plans first: the starter prices were not found.');
      return 1;
    }
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: lookupKeys.map((lookupKey) => ({ price: priceByKey.get(lookupKey) as string })),
      trial_end: clockTime + TRIAL_SECONDS,
    });

    io.log('3. Reporting 6 SMS segments and 4 AI call minutes, and adding a 54.00 exact report.');
    await stripe.billing.meterEvents.create({
      event_name: METER_EVENT_NAME.sms_segment,
      payload: { stripe_customer_id: customer.id, value: '6' },
      identifier: randomUUID(),
      timestamp: clockTime,
    });
    await stripe.billing.meterEvents.create({
      event_name: METER_EVENT_NAME.ai_call_minute,
      payload: { stripe_customer_id: customer.id, value: '4' },
      identifier: randomUUID(),
      timestamp: clockTime,
    });
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: 5400,
      currency: 'usd',
      description: 'Exact roof report — 812 Oak St (smoke)',
    });

    io.log('4. Advancing the clock 15 days.');
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: clockTime + ADVANCE_SECONDS });
    const started = Date.now();
    for (;;) {
      const current = await stripe.testHelpers.testClocks.retrieve(clock.id);
      if (current.status === 'ready') break;
      const waited = Math.round((Date.now() - started) / 1000);
      if (Date.now() - started >= POLL_TIMEOUT_MS) {
        io.error('Stripe did not finish moving the test clock in 5 minutes. Check the test clock in the dashboard.');
        return 1;
      }
      io.log(`Waiting for Stripe to catch up (${waited} s)…`);
      await sleep(POLL_MS);
    }

    io.log('5. Latest invoice:');
    const invoices = await stripe.invoices.list({ customer: customer.id, limit: 1 });
    const invoice = invoices.data[0];
    if (!invoice) {
      io.error('No invoice was found for the test customer. Check the test clock in the dashboard.');
      return 1;
    }
    for (const line of invoice.lines.data) {
      io.log(`  ${line.description ?? 'Line item'}: ${dollars(line.amount)}`);
    }
    io.log(`  Total: ${dollars(invoice.total)}`);

    io.log('Dashboard links (test mode):');
    io.log(`  Customer: https://dashboard.stripe.com/test/customers/${customer.id}`);
    io.log(`  Subscription: https://dashboard.stripe.com/test/subscriptions/${subscription.id}`);
    io.log(`  Test clock: https://dashboard.stripe.com/test/test-clocks/${clock.id}`);
    io.log(`  Invoice: https://dashboard.stripe.com/test/invoices/${invoice.id}`);
    return 0;
  } catch {
    io.error(STOPPED);
    return 1;
  }
}

/** True when this file is the script being run (`tsx src/scripts/smoke/stripe-test-clock.ts`), not a module a test imported. */
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
