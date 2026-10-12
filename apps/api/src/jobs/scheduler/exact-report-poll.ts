import type { AppDeps } from '../../app.ts';

/**
 * Every 10 minutes: asks the exact-report provider about orders still waiting. Stub from E1 Task 5;
 * the real body arrives in a later task.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export async function pollExactReports(_deps: AppDeps, _now: Date): Promise<void> {}
