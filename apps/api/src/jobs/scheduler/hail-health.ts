import type { AppDeps } from '../../app.ts';

/** Every 15 minutes: checks the hail data is fresh, using HAIL_STALE_MINUTES (S1 Task 10). Stub from S1 Task 7; the real body arrives in that task. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export async function hailHealth(_deps: AppDeps, _now: Date): Promise<void> {}
