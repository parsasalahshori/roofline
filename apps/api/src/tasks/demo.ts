import type { NewTask } from './service.ts';

/** How long the demo plan waits for a yes before it expires. */
export const DEMO_TASK_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * The F2 demo plan (the seed makes it; the review screen is built against it): a Storm Scout plan
 * with one step of each approval class, so partial approval shows (an office user can approve the
 * text and the routes, and the ads wait for the owner). Its window is 48 hours from `now`.
 */
export function demoTask(now: Date): NewTask {
  return {
    agent: 'storm_scout',
    kind: 'storm_plan',
    title: 'Storm plan: hail on the north side',
    summary: 'Text the customers under the hail swath, send the reps door to door, and run ads on the swath.',
    expiresAt: new Date(now.getTime() + DEMO_TASK_WINDOW_MS),
    steps: [
      { type: 'demo_message', payload: { label: 'Text 31 customers' } },
      { type: 'demo_noop', payload: { label: 'Door-knock routes for 4 reps' } },
      { type: 'demo_spend', payload: { label: 'Google + Facebook ads on the swath', maxSpendCents: 27000 } },
    ],
  };
}
