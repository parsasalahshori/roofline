import type { AppDeps } from '../../app.ts';

/** Every 10 minutes: queues a storm-match-company job per company (S1 Task 9). Stub from S1 Task 7; the real body arrives in that task. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export async function stormMatch(_deps: AppDeps, _now: Date): Promise<void> {}
