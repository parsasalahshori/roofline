import type { AppDeps } from '../../app.ts';

/**
 * Scheduled job: polls texting registration status. Stub: does nothing until its task fills it in. Runs on its cron in the
 * worker (SCHEDULES in worker.ts), with the clock's time.
 */
export async function pollTexting(deps: AppDeps, now: Date): Promise<void> {
  void deps;
  void now;
}
