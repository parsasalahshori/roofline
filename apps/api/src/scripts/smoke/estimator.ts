import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AwsClient } from 'aws4fetch';
import { getProposal, listSteps, withTenant, type TenantContext } from '@roofline/db';
import type { Config } from '../../config.ts';
import type { AppDeps } from '../../app.ts';
import { buildDeps, loadConfigOrExit } from '../../deps.ts';
import { draftProposalSend } from '../../estimator/send-proposal.ts';
import type { JobQueue } from '../../jobs/queue.ts';
import { eagleViewOrdersFor } from '../../providers/eagleview/orders.ts';
import { eagleViewPropertyDataFor } from '../../providers/eagleview/property-data.ts';
import { AerialUnavailableError } from '../../providers/aerial.ts';
import { ExactOrderUncertainError, ExactReportsUnavailableError } from '../../providers/exact-reports.ts';
import type { ObjectStore } from '../../providers/object-store.ts';
import { r2For } from '../../providers/r2.ts';
import { approveTask } from '../../tasks/service.ts';
import type { StepQueue } from '../../tasks/queue.ts';
import { runStep } from '../../tasks/runner.ts';
import { SmokeRefused } from './guards.ts';
import {
  assertConfirmedProviders,
  assertEstimatorConfig,
  assertPlaceOrderAllowed,
  maskPhone,
  parseEstimatorArgs,
  redactSecrets,
  type EstimatorArgs,
} from './estimator-guards.ts';

/*
 * Manual smoke test for the Estimator's three real providers, by hand only. It calls live services:
 * EagleView (sandbox), Cloudflare R2, and the real texting path on staging. It must never run in
 * automation, and it is never run by CI or by any agent. The owner runs it with their own sandbox
 * and staging credentials. See docs/superpowers/e1-manual-smoke.md for each check and its expected result.
 *
 *   npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --eagleview-sandbox
 *   npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --eagleview-sandbox --place-order
 *   npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --r2
 *   npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --sms +14025550123
 *
 * Checks, run in this order, one PASS or FAIL line each:
 *   - --eagleview-sandbox: Property Data on SMOKE_ADDRESS (polled up to 10 times, 3 s apart), then
 *     PriceOrder. The sandbox never charges. --place-order (refused unless EAGLEVIEW_ENV=sandbox) also
 *     places the sandbox order and prints its reference id.
 *   - --r2: put, get and signed delete of one test object under smoke/, then a get that must find nothing.
 *   - --sms <E.164>: the staging draft proposal SMOKE_PROPOSAL_ID, whose customer must hold that phone and
 *     have texting consent, is drafted, approved as the owner (SMOKE_OWNER_USER_ID) and run through the
 *     real send step (runStep), so the real messaging send gate and Twilio adapter are used.
 *
 * Env: EAGLEVIEW_CLIENT_ID, EAGLEVIEW_CLIENT_SECRET, EAGLEVIEW_PRODUCT_ID, EAGLEVIEW_ENV (must be sandbox
 * for --place-order); R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET; DATABASE_URL_TENANT,
 * DATABASE_URL_SYSTEM, ENCRYPTION_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and the rest of the staging
 * config for --sms; SMOKE_COMPANY_ID, SMOKE_PROPOSAL_ID, SMOKE_OWNER_USER_ID for --sms.
 *
 * Nothing secret is printed: every line goes through redactSecrets, the phone is printed only masked, and
 * a provider's own text is never printed. A failed check prints a plain sentence; the script exits 1 when
 * any check fails.
 */

export const USAGE =
  'Usage: npm run smoke:estimator -w @roofline/api -- --confirm-real-providers [--eagleview-sandbox] [--place-order] [--r2] [--sms <E.164>]';

/** A documented Omaha test address (Farnam Street, downtown Omaha). Confirm it against EagleView's sandbox list before the first run; the sandbox list is not in this repo. */
export const SMOKE_ADDRESS = { street: '1200 Farnam St', city: 'Omaha', state: 'NE', zip: '68102' } as const;
const SMOKE_ADDRESS_LINE = `${SMOKE_ADDRESS.street}, ${SMOKE_ADDRESS.city}, ${SMOKE_ADDRESS.state} ${SMOKE_ADDRESS.zip}`;

const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 3000;
const R2_TEST_TEXT = 'Roofline estimator smoke test. Safe to delete.';
const GENERIC_CHECK_FAILURE = 'The check could not finish. No more detail is shown, to keep provider text out of the terminal.';
const GENERIC_REFUSAL = 'The smoke run was refused.';
const NO_SUCH_PROPOSAL = 'The smoke proposal was not found for this company.';
const PHONE_MISMATCH = "The smoke proposal's customer phone is not the --sms number. Nothing was sent.";
const SMOKE_IDS = ['SMOKE_COMPANY_ID', 'SMOKE_PROPOSAL_ID', 'SMOKE_OWNER_USER_ID'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SmokeIo = { log(line: string): void; error(line: string): void };

const consoleIo: SmokeIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** A check that failed with a sentence of our own. Its message is safe to print as is. */
class PlainFailure extends Error {}

/** Only these errors carry messages written by this code base, so only these are printed. */
function printableReason(err: unknown): string {
  if (err instanceof SmokeRefused || err instanceof PlainFailure) return err.message;
  if (err instanceof AerialUnavailableError || err instanceof ExactReportsUnavailableError) return err.message;
  if (err instanceof ExactOrderUncertainError) return err.message;
  return GENERIC_CHECK_FAILURE;
}

/** Every line passes through the secret list before it is printed. */
function redacting(io: SmokeIo, secrets: readonly (string | undefined)[]): SmokeIo {
  return {
    log: (line) => io.log(redactSecrets(line, secrets)),
    error: (line) => io.error(redactSecrets(line, secrets)),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 12345 cents -> "$123.45". */
function formatDollars(cents: number): string {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Runs one check: prints PASS with its detail, or FAIL with the reason. Returns whether it passed. */
async function runCheck(io: SmokeIo, label: string, check: () => Promise<string>): Promise<boolean> {
  try {
    const detail = await check();
    io.log(detail === '' ? `PASS ${label}` : `PASS ${label}: ${detail}`);
    return true;
  } catch (err) {
    io.log(`FAIL ${label}: ${printableReason(err)}`);
    return false;
  }
}

/** Property Data, PriceOrder and (only with --place-order) PlaceOrder in the EagleView sandbox. */
async function runEagleView(config: Config, io: SmokeIo, placeOrder: boolean): Promise<boolean[]> {
  const aerial = eagleViewPropertyDataFor(config);
  const orders = eagleViewOrdersFor(config);
  if (!aerial || !orders) {
    io.log('FAIL eagleview setup: EagleView is not configured.');
    return [false];
  }

  // The first request fetches the EagleView token, so "property data" also covers the token.
  const property = await runCheck(io, 'eagleview property data', async () => {
    const { requestId } = await aerial.start(SMOKE_ADDRESS_LINE);
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
      const result = await aerial.result(requestId);
      if (result.status === 'complete') {
        const [first] = result.roofs;
        if (first === undefined) throw new PlainFailure('EagleView returned no roof.');
        return `${result.roofs.length} roof(s); first roof ${first.areaSqFt} sq ft, pitch ${first.pitchX12}/12`;
      }
      if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
    }
    throw new PlainFailure(`EagleView was not ready after ${POLL_ATTEMPTS} tries.`);
  });

  const orderInput = {
    address: { ...SMOKE_ADDRESS },
    productId: config.EAGLEVIEW_PRODUCT_ID,
    referenceId: `smoke-${Date.now()}`,
  };

  const priced = await runCheck(io, 'eagleview price (sandbox, not charged)', async () => {
    const price = await orders.price(orderInput);
    return `${formatDollars(price.minCents)}, quote valid until ${price.expiresAt.toISOString()}`;
  });

  const results = [property, priced];
  if (!placeOrder) {
    io.log('SKIP place order (pass --place-order, sandbox only)');
    return results;
  }
  results.push(
    await runCheck(io, 'eagleview place order (sandbox)', async () => {
      const { reportId } = await orders.order(orderInput);
      return `reference ${reportId}`;
    }),
  );
  return results;
}

/** Deletes one object with a SigV4-signed DELETE, the way r2.ts signs its requests. */
async function deleteR2Object(config: Config, key: string): Promise<void> {
  const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket } = config;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new PlainFailure('R2 is not configured.');
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  const base = `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}`;
  const url = `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const signed = await client.sign(url, { method: 'DELETE' });
  const res = await fetch(signed);
  if (res.status !== 204 && res.status !== 200) {
    throw new PlainFailure(`R2 refused the delete (status ${res.status}).`);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** One test object: put, get (must match), signed delete, then get (must be gone). */
async function runR2(config: Config, io: SmokeIo): Promise<boolean[]> {
  const store: ObjectStore | null = r2For(config);
  if (!store) {
    io.log('FAIL r2 setup: R2 is not configured.');
    return [false];
  }
  const key = `smoke/estimator-${Date.now()}.txt`;
  const bytes = new TextEncoder().encode(R2_TEST_TEXT);

  const put = await runCheck(io, 'r2 put', async () => {
    await store.put(key, bytes, 'text/plain');
    return '';
  });
  if (!put) {
    // Nothing was confirmed stored, so the rest is not run. A stray test object under smoke/ can be removed by hand.
    io.log('SKIP r2 get, r2 delete and r2 get after delete (the put did not succeed)');
    return [put];
  }
  const got = await runCheck(io, 'r2 get', async () => {
    const back = await store.get(key);
    if (back === null || !sameBytes(back, bytes)) throw new PlainFailure('The test object did not read back the same.');
    return '';
  });
  const deleted = await runCheck(io, 'r2 delete', async () => {
    await deleteR2Object(config, key);
    return '';
  });
  const gone = await runCheck(io, 'r2 get after delete', async () => {
    const back = await store.get(key);
    if (back !== null) throw new PlainFailure('The test object is still there after delete.');
    return '';
  });
  return [put, got, deleted, gone];
}

/**
 * The real send path on staging. The draft proposal's customer must hold `phone` (checked before anything is
 * drafted), the owner approves the send step, and the step runs through `runStep`, the worker's own runner.
 * The result is the step's own plain outcome: our reason text, never provider text. The link is never printed.
 */
export async function runSmsCheck(
  deps: AppDeps,
  ctx: TenantContext,
  proposalId: string,
  phone: string,
  io: SmokeIo,
): Promise<boolean> {
  const label = `sms handed to the send path (to ${maskPhone(phone)})`;
  try {
    const view = await withTenant(deps.pools, ctx, (tx) => getProposal(tx, ctx, proposalId));
    if (!view) throw new PlainFailure(NO_SUCH_PROPOSAL);
    if (view.customer.phone !== phone) throw new PlainFailure(PHONE_MISMATCH);

    const { taskId } = await draftProposalSend(deps, ctx, proposalId);
    const approved = await withTenant(deps.pools, ctx, async (tx) => {
      const steps = await listSteps(tx, ctx, [taskId]);
      const seen = steps.map((step) => ({ id: step.id, version: step.version }));
      return approveTask(tx, ctx, taskId, seen, { now: deps.clock.now(), ip: null });
    });
    if (!approved) throw new PlainFailure('The send task could not be approved.');
    if (approved.toEnqueue.length === 0) throw new PlainFailure('Nothing was queued to send.');

    for (const stepId of approved.toEnqueue) await runStep(deps, ctx.companyId, stepId);

    const after = await withTenant(deps.pools, ctx, (tx) => listSteps(tx, ctx, [taskId]));
    const ran = after.filter((step) => approved.toEnqueue.includes(step.id));
    if (ran.length > 0 && ran.every((step) => step.status === 'done')) {
      io.log(`PASS ${label}`);
      return true;
    }
    if (ran.length > 0 && ran.every((step) => step.status === 'running')) {
      io.log(`PASS ${label}, scheduled for later (not yet sent)`);
      return true;
    }
    const reason = ran.find((step) => step.errorPlain)?.errorPlain ?? 'The text did not go out.';
    io.log(`FAIL ${label}: ${reason}`);
    return false;
  } catch (err) {
    io.log(`FAIL ${label}: ${printableReason(err)}`);
    return false;
  }
}

/** Nothing here is ever used: the smoke run calls the runner directly, so the queues must never be asked for work. */
const NO_QUEUE = 'The smoke run does not use the queues.';
const noStepQueue: StepQueue = {
  enqueueStep: async () => {
    throw new PlainFailure(NO_QUEUE);
  },
};
const noJobQueue: JobQueue = {
  send: async () => {
    throw new PlainFailure(NO_QUEUE);
  },
};

/** The staging ids for --sms. Names the missing keys, never a value. */
function smokeIds(env: NodeJS.ProcessEnv): { companyId: string; proposalId: string; ownerId: string } {
  const missing = SMOKE_IDS.filter((key) => !UUID.test((env[key] ?? '').trim()));
  if (missing.length > 0) throw new SmokeRefused(`Set ${missing.join(', ')} to staging UUIDs first.`);
  return {
    companyId: env.SMOKE_COMPANY_ID!.trim(),
    proposalId: env.SMOKE_PROPOSAL_ID!.trim(),
    ownerId: env.SMOKE_OWNER_USER_ID!.trim(),
  };
}

/** Runs the chosen checks and returns the exit code. Nothing is called before every guard has passed. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: SmokeIo = consoleIo): Promise<number> {
  let args: EstimatorArgs;
  try {
    args = parseEstimatorArgs(argv);
    assertConfirmedProviders(argv);
    assertPlaceOrderAllowed(args, env);
    assertEstimatorConfig(args, env);
  } catch (err) {
    io.error(err instanceof SmokeRefused ? err.message : GENERIC_REFUSAL);
    io.error(USAGE);
    return 1;
  }
  if (!args.eagleview && !args.r2 && args.sms === null) {
    io.error('Pick at least one check: --eagleview-sandbox, --r2 or --sms <E.164>.');
    io.error(USAGE);
    return 1;
  }

  const config = loadConfigOrExit(env);
  const out = redacting(io, [
    config.EAGLEVIEW_CLIENT_ID,
    config.EAGLEVIEW_CLIENT_SECRET,
    config.R2_ACCESS_KEY_ID,
    config.R2_SECRET_ACCESS_KEY,
    config.TWILIO_AUTH_TOKEN,
    config.ENCRYPTION_KEY,
    config.DATABASE_URL_TENANT,
    config.DATABASE_URL_SYSTEM,
  ]);

  const results: boolean[] = [];
  try {
    if (args.eagleview) results.push(...(await runEagleView(config, out, args.placeOrder)));
    if (args.r2) results.push(...(await runR2(config, out)));
    if (args.sms !== null) {
      let ids: ReturnType<typeof smokeIds>;
      try {
        ids = smokeIds(env);
      } catch (err) {
        out.error(err instanceof SmokeRefused ? err.message : GENERIC_REFUSAL);
        return 1;
      }
      const deps = buildDeps(config, noStepQueue, noJobQueue);
      try {
        const owner: TenantContext = { companyId: ids.companyId, userId: ids.ownerId, role: 'owner', canApproveSpend: true };
        results.push(await runSmsCheck(deps, owner, ids.proposalId, args.sms, out));
      } finally {
        await deps.pools.end();
      }
    }
  } catch {
    out.error(GENERIC_CHECK_FAILURE);
    return 1;
  }

  const passed = results.filter(Boolean).length;
  out.log(`${passed} of ${results.length} checks passed.`);
  return passed === results.length ? 0 : 1;
}

/** True when this file is the script being run, not a module a test imported. */
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
