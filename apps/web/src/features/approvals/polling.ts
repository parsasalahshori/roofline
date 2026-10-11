import type { TaskView } from '../../api/types.ts';

/** How often a plan that is running is asked for again, in milliseconds. */
export const POLL_EVERY_MS = 2000;
/** How long after an approval the plan keeps being asked for, whatever its steps say. */
export const POLL_AFTER_APPROVE_MS = 10_000;

/**
 * The `refetchInterval` for a plan: POLL_EVERY_MS while a step is queued or running, or until
 * `pollUntil` (the window after an approval), `false` otherwise.
 */
export function pollInterval(task: TaskView | undefined, pollUntil: number, now: number): number | false {
  const working = task?.steps.some((step) => step.status === 'queued' || step.status === 'running') ?? false;
  return working || now < pollUntil ? POLL_EVERY_MS : false;
}
