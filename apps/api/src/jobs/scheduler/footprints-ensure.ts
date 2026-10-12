import type { AppDeps } from '../../app.ts';

/**
 * Every 15 minutes: queues a footprints-load job for each state the companies need. Stub from E1
 * Task 5; the real body arrives in a later task.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export async function ensureFootprints(_deps: AppDeps, _now: Date): Promise<void> {}
