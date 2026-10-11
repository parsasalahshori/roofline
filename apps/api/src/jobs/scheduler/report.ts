import type { AppDeps } from '../../app.ts';
import { logErrorToConsole } from '../../errors.ts';

/**
 * Hands an error from a scheduled job to the app's log (`deps.logError`, in the safe form of
 * `describeErrorForLog`) and carries on: one company's or one step's failure must not stop the
 * job for the others. A failing logger is swallowed for the same reason.
 */
export function reportJobError(deps: AppDeps, err: unknown, where: string): void {
  try {
    (deps.logError ?? logErrorToConsole)(err, where);
  } catch {
    // Nothing more to do: the next run of the job tries again.
  }
}
