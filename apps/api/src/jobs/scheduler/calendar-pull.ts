import type { AppDeps } from '../../app.ts';
import { pullCalendars as pull } from '../../calendar/pull.ts';

/** Scheduled job: pulls outside calendar changes every 5 minutes (C1 Task 14). Delegates to calendar/pull.ts. */
export async function pullCalendars(deps: AppDeps, now: Date): Promise<void> {
  await pull(deps, now);
}
