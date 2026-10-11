import { renewStepLease, type StepRow, type TenantContext, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';

/*
 * The step lease and its heartbeat. This module has no value imports from the runner or the
 * handlers, so the batch handler (messaging/send-batch.ts) can use it without an import cycle
 * (runner.ts -> handlers.ts -> send-batch.ts). runner.ts re-exports everything here.
 */

/** How long a claim owns its step. A run still going after this may lose the step to the sweeper. */
export const LEASE_MS = 10 * 60 * 1000;

/** How often a long-running handler renews its lease (by the app clock). */
export const LEASE_RENEW_EVERY_MS = 60_000;

/**
 * Keeps a long handler's lease alive. A long handler calls `keep()` before each item of its work.
 * `keep()` renews the lease to now + LEASE_MS once LEASE_RENEW_EVERY_MS has passed since the claim
 * or the last renewal (by the app clock), and it does not touch the database before that.
 * A `false` means the step is no longer this run's (a newer run has it, or it went back to the
 * queue), so the handler must stop and do no more work on it. Once false, `keep()` stays false.
 * A database error is not caught here: it propagates, and the runner retries the step.
 */
export function leaseKeeper(deps: AppDeps, ctx: TenantContext, step: StepRow): { keep(): Promise<boolean> } {
  // The claim starts the first lease, so the clock for the first renewal starts now.
  let lastAt = deps.clock.now();
  let lost = false;
  return {
    async keep(): Promise<boolean> {
      if (lost) return false;
      const now = deps.clock.now();
      if (now.getTime() - lastAt.getTime() < LEASE_RENEW_EVERY_MS) return true;
      const renewed = await withTenant(deps.pools, ctx, (tx) =>
        renewStepLease(tx, ctx, step.id, step.runSeq, new Date(now.getTime() + LEASE_MS)),
      );
      if (!renewed) {
        lost = true;
        return false;
      }
      lastAt = now;
      return true;
    },
  };
}
