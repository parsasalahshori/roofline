import {
  claimStep,
  finishClaimedStep,
  lockClaimedStep,
  type StepFinish,
  type StepRow,
  type TenantContext,
  type Tx,
  withTenant,
} from '@roofline/db';
import { isStepType, type StepResult, type StepType } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { builtInHandlers } from './handlers.ts';
import { refreshTask } from './service.ts';

/*
 * Running one approved step (spec 4.1 "Running"). The queue calls `runStep` with a company and a
 * step id; the step's type decides which handler does the work. A step is run at most 5 times: a
 * handler that throws is tried again by the queue until then, and after the fifth the step needs a
 * person ("We couldn't finish this step. ..."), who can retry it from the review screen.
 */

/** How many times a step is run before it needs a person. */
export const MAX_ATTEMPTS = 5;

const GAVE_UP = "We couldn't finish this step. We'll keep the details here so you can retry.";
const CANT_RUN_YET = "This kind of step can't run yet.";

/** How one run of a step ended. `running` means the step goes on by itself (texts waiting for quiet hours to end, say). */
export type StepOutcome = {
  status: 'done' | 'running' | 'failed' | 'needs_attention';
  result: StepResult;
  /** Shown to a person when the step failed or needs attention. */
  errorPlain?: string;
};

/**
 * Does the work of one step. It gets the step as claimed (status `running`, payload included) and
 * the company's system context, and runs inside the transaction that saves its outcome: what it
 * writes through `tx` is kept only if it returns. Throwing means "try again later"; the queue does,
 * up to 5 runs in all. A handler must be safe to run twice for one step: it uses the step's
 * idempotency key (or the step id) so a retry never repeats an outbound effect.
 */
export type StepHandler = (deps: AppDeps, tx: Tx, ctx: TenantContext, step: StepRow) => Promise<StepOutcome>;

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

/** The runner acts for the company with no signed-in person; it approves nothing (permissions.ts). */
const systemCtx = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

/**
 * Runs one step for the queue.
 * 1. Claims it in a transaction of its own: `running`, `attempts + 1`. A step that is not `queued`
 *    or `running` (not approved, already finished, unknown, another company's) is left alone.
 *    The claim commits first, so every run is counted even when the run itself is rolled back.
 * 2. In a second transaction, locks the step (still this run's) and calls its handler, then saves
 *    the outcome and brings the task's status in line (`refreshTask`).
 * 3. When the handler throws, that transaction rolls back. Before the fifth run the error is thrown
 *    on, so the queue tries again; on the fifth the step needs attention with a plain reason.
 * A step whose type has no handler needs attention at once ("This kind of step can't run yet.");
 * one claimed for a sixth time (a run that crashed the process on its fifth try) is not run again.
 */
export async function runStep(deps: AppDeps, companyId: string, stepId: string): Promise<void> {
  const { pools, clock } = deps;
  const ctx = systemCtx(companyId);

  const claimed = await withTenant(pools, ctx, (tx) => claimStep(tx, ctx, stepId, clock.now()));
  if (!claimed) return;

  const handler = isStepType(claimed.type) ? handlers.get(claimed.type) : undefined;
  if (!handler) {
    await settle(deps, ctx, claimed, { status: 'needs_attention', errorPlain: CANT_RUN_YET });
    return;
  }
  if (claimed.attempts > MAX_ATTEMPTS) {
    await settle(deps, ctx, claimed, { status: 'needs_attention', errorPlain: GAVE_UP });
    return;
  }

  try {
    await withTenant(pools, ctx, async (tx) => {
      const step = await lockClaimedStep(tx, ctx, stepId, claimed.attempts);
      if (!step) return; // a later claim of the same step owns it now
      const outcome = await handler(deps, tx, ctx, step);
      await finishClaimedStep(
        tx,
        ctx,
        step.id,
        step.attempts,
        { status: outcome.status, result: outcome.result, errorPlain: outcome.errorPlain ?? null },
        clock.now(),
      );
      await refreshTask(tx, ctx, step.taskId, clock.now());
    });
  } catch (err) {
    if (claimed.attempts < MAX_ATTEMPTS) throw err;
    await settle(deps, ctx, claimed, { status: 'needs_attention', errorPlain: GAVE_UP });
  }
}

/** Ends a claimed step without running its handler, and brings its task in line. */
async function settle(deps: AppDeps, ctx: TenantContext, claimed: StepRow, finish: StepFinish): Promise<void> {
  const { pools, clock } = deps;
  await withTenant(pools, ctx, async (tx) => {
    const saved = await finishClaimedStep(tx, ctx, claimed.id, claimed.attempts, finish, clock.now());
    if (saved) await refreshTask(tx, ctx, saved.taskId, clock.now());
  });
}
