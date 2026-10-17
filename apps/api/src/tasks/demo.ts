import type { NewTask } from './service.ts';

/** How long the demo plan waits for a yes before it expires. */
export const DEMO_TASK_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * When the demo text goes out: 10:00 AM today while that is still ahead in the company's day, else tomorrow. The plan keeps
 * the words it was made with, so a label that said "today" would read as a time already gone on any evening.
 */
export function demoSendTime(now: Date, timeZone = 'America/Chicago'): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
  return `${hour < 10 ? 'today' : 'tomorrow'} at 10:00 AM`;
}

/**
 * The F2 demo plan (the seed makes it; the review screen is built against it): a Storm Scout plan
 * with one step of each approval class, so partial approval shows (an office user can approve the
 * text and the routes, and the ads wait for the owner). Its window is 48 hours from `now`.
 *
 * The text step carries a sample message that names `companyName` (the seed passes the company's
 * own name; "your roofer" when none is given), how many customers it goes to, and when it goes out (10:00 AM, today or
 * tomorrow, from the Chicago clock).
 * The spend step names the area it covers. Those details are optional in the step type (steps.ts),
 * so the plan still reads the same to any code that only knows the three step labels.
 */
export function demoTask(now: Date, companyName = 'your roofer'): NewTask {
  return {
    agent: 'storm_scout',
    kind: 'storm_plan',
    title: 'Storm plan: hail on the north side',
    summary: 'Text the customers under the hail swath, send the reps door to door, and run ads on the swath.',
    expiresAt: new Date(now.getTime() + DEMO_TASK_WINDOW_MS),
    steps: [
      {
        type: 'demo_message',
        payload: {
          label: 'Text 31 customers',
          sample: `Hi Maria, it's ${companyName}. Tuesday's hail hit your street. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.`,
          recipientCount: 31,
          sendTime: demoSendTime(now),
        },
      },
      { type: 'demo_noop', payload: { label: 'Door-knock routes for 4 reps' } },
      {
        type: 'demo_spend',
        payload: { label: 'Google + Facebook ads on the swath', maxSpendCents: 27000, area: 'North side swath · 4.2 sq mi' },
      },
    ],
  };
}
