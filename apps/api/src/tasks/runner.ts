import {
  claimStep,
  finishClaimedStep,
  getTask,
  type StepFinish,
  type StepRow,
  type TenantContext,
  withTenant,
} from '@roofline/db';
import { isStepType, type StepResult, type StepType } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { logErrorToConsole } from '../errors.ts';
import { systemContext } from '../permissions.ts';
import { builtInHandlers } from './handlers.ts';
import { refreshTask } from './service.ts';

/*
 * Running one approved step (spec 4.1 "Running"). The queue calls `runStep` with a company and a
 * step id; the step's type decides which handler does the work. A step is run at most 5 times: a
 * handler that throws is tried again by the queue until then, and after the fifth the step needs a
 * person ("We couldn't finish this step. ..."), who can retry it from the review screen.
 *
 * No lock is held while a handler runs. The claim commits a lease (who owns the step, until when),
 * the handler commits its own progress in transactions of its own, and the run's end is one UPDATE
 * that only lands if the step is still this run's.
 */

/** How many times a step is run before it needs a person. */
export const MAX_ATTEMPTS = 5;

/** How long a claim owns its step. A run still going after this may lose the step to the sweeper. */
export const LEASE_MS = 10 * 60 * 1000;

const GAVE_UP = "We couldn't finish this step. We'll keep the details here so you can retry.";
const CANT_RUN_YET = "This kind of step can't run yet.";
const RETRYING = "This step hit a problem. We'll try it again shortly.";

/**
 * How one run of a step ended.
 * - `done`, `failed`, `needs_attention`: the step is finished (give `errorPlain` for the last two).
 * - `running`: the step is parked and finishes by itself later (texts waiting out quiet hours, for
 *   example, which the dispatcher completes). A parked step has no lease, so the sweeper leaves it
 *   alone and a second delivery does not run it again.
 */
export type StepOutcome = {
  status: 'done' | 'running' | 'failed' | 'needs_attention';
  result: StepResult;
  /** Shown to a person when the step failed or needs attention. */
  errorPlain?: string;
};

/**
 * Does the work of one step. It gets the app's deps, the company's system context, and the step as
 * claimed (status `running`, `attempts` counting this run, `leaseExpiresAt` set, payload included).
 *
 * The contract:
 * - **No lock is held for it.** The runner keeps no transaction open while the handler runs, so
 *   the handler opens its own short ones (`withTenant(deps.pools, ctx, ...)`) and commits its
 *   progress item by item, before and after each outside call (each text sent, each charge made).
 *   What it commits stays committed, whatever happens to the run after.
 * - **It may run more than once for one step** (a retry after a throw, a delivery after a crash,
 *   a person's retry). It uses the step's idempotency key (or the step id) and what it committed
 *   earlier, so a retry never repeats an outside effect such as texting someone twice.
 * - **Its outcome is saved only if the step is still this run's.** A run that outlived its lease
 *   may find a newer run has the step; its outcome is then dropped. A handler should finish well
 *   within `LEASE_MS`.
 * - **Throwing means "try again later".** The queue does, up to 5 runs in all. A thrown error is
 *   logged, so it must not carry customer data: no phone numbers, names or message bodies in its
 *   message.
 */
export type StepHandler = (deps: AppDeps, ctx: TenantContext, step: StepRow) => Promise<StepOutcome>;

const handlers = new Map<StepType, StepHandler>(Object.entries(builtInHandlers) as [StepType, StepHandler][]);

/**
 * Sets the handler for a type of step (a feature module registers its own; tests swap one in).
 * Returns a function that puts back whatever was there before.
 */
export function registerStepHandler(type: StepType, handler: StepHandler): () => void {
  const previous = handlers.get(type);
  handlers.set(type, handler);
  return () => {
    if (previous) handlers.set(type, previous);
    else handlers.delete(type);
  };
}

/**
 * Runs one step for the queue.
 * 1. **Claim**, in a transaction of its own: a `queued` step becomes `running` with `attempts + 1`,
 *    the next `runSeq` (this run's own number) and a lease of `LEASE_MS`. Anything else (not
 *    approved, already running or parked, finished, unknown, another company's) is left alone, so
 *    a second delivery is a no-op.
 * 2. **Handler**, with no lock held (see `StepHandler`).
 * 3. **End**, in one short transaction: the task row is locked first (the order every writer
 *    takes), then the outcome is saved if the step is still this run's (`running` at this run's
 *    `runSeq`; not `attempts`, which a person's retry resets), the lease is cleared and the task's
 *    status follows (`refreshTask`). A stale run writes nothing, and a stale throw puts nothing back.
 * 4. **A throw** before the fifth run puts the step back to `queued` (with a plain reason) and
 *    throws on, so the queue tries again. On the fifth, the error goes to `deps.logError` (in the
 *    safe form of `describeErrorForLog`) and the step needs attention with a plain sentence: the
 *    error itself is never stored on the step or shown to a person.
 * A step whose type has no handler needs attention at once ("This kind of step can't run yet."),
 * and so does one claimed after it already used its 5 attempts (a run that died on its fifth try
 * and was put back by the sweeper): it is not run a sixth time.
 */
export async function runStep(deps: AppDeps, companyId: string, stepId: string): Promise<void> {
  const { pools, clock } = deps;
  // The runner acts for the company with no signed-in person; it approves nothing.
  const ctx = systemContext(companyId);

  const now = clock.now();
  const claimed = await withTenant(pools, ctx, (tx) =>
    claimStep(tx, ctx, stepId, now, new Date(now.getTime() + LEASE_MS)),
  );
  if (!claimed) return;

  const handler = isStepType(claimed.type) ? handlers.get(claimed.type) : undefined;
  if (!handler) {
    await end(deps, ctx, claimed, { status: 'needs_attention', errorPlain: CANT_RUN_YET });
    return;
  }
  if (claimed.attempts > MAX_ATTEMPTS) {
    await end(deps, ctx, claimed, { status: 'needs_attention', errorPlain: GAVE_UP });
    return;
  }

  let outcome: StepOutcome;
  try {
    outcome = await handler(deps, ctx, claimed);
  } catch (err) {
    if (claimed.attempts < MAX_ATTEMPTS) {
      await end(deps, ctx, claimed, { status: 'queued', errorPlain: RETRYING });
      throw err;
    }
    // Logged first, so the cause is on record even if saving the outcome fails too.
    report(deps, err, `step ${stepId} (gave up after ${MAX_ATTEMPTS} attempts)`);
    await end(deps, ctx, claimed, { status: 'needs_attention', errorPlain: GAVE_UP });
    return;
  }
  await end(deps, ctx, claimed, { status: outcome.status, result: outcome.result, errorPlain: outcome.errorPlain ?? null });
}

/**
 * Ends a run: locks the task, saves the outcome if the step is still this run's, and brings the
 * task in line. Writes nothing for a stale run.
 */
async function end(deps: AppDeps, ctx: TenantContext, claimed: StepRow, finish: StepFinish): Promise<void> {
  const { pools, clock } = deps;
  await withTenant(pools, ctx, async (tx) => {
    const now = clock.now();
    await getTask(tx, ctx, claimed.taskId, { forUpdate: true });
    const saved = await finishClaimedStep(tx, ctx, claimed.id, claimed.runSeq, finish, now);
    if (saved) await refreshTask(tx, ctx, saved.taskId, now);
  });
}

/** Hands an error to the app's log. A failing logger must not stop the step being marked. */
function report(deps: AppDeps, err: unknown, where: string): void {
  try {
    (deps.logError ?? logErrorToConsole)(err, where);
  } catch {
    // Nothing more to do: the step still gets its plain reason.
  }
}
