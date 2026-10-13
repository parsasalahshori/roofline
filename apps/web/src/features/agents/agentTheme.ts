import type { ScreenAgent } from '@roofline/shared';

/** The order the dashboard lays the agents out, left to right along the roof. */
export const DASH_ORDER: readonly ScreenAgent[] = ['storm_scout', 'front_desk', 'estimator', 'claims', 'scheduler', 'follow_up'];

/** Each agent's own color (node ring, card tab, handoff dot). Tokens first, reference values as fallback. */
export const AGENT_COLOR: Record<ScreenAgent, string> = {
  storm_scout: 'var(--ds-agent-storm, #6b3fa0)',
  front_desk: 'var(--ds-agent-desk, #138a8a)',
  estimator: 'var(--ds-agent-estimator, #e0a100)',
  claims: 'var(--ds-agent-claims, #1f7a5a)',
  scheduler: 'var(--ds-agent-scheduler, #c0652a)',
  follow_up: 'var(--ds-agent-follow, #2f6de0)',
};

/** Whole hours from minutes, never below zero. */
export const wholeHours = (minutes: number): number => Math.max(0, Math.round(minutes / 60));

/** "1,234" style number. */
export const groupDigits = (n: number): string => n.toLocaleString('en-US');

/** Dollars of staff time from minutes and an hourly rate in cents, rounded to the dollar. */
export const staffDollars = (minutes: number, hourlyRateCents: number): number => Math.round(((minutes / 60) * hourlyRateCents) / 100);

/** The time an action happened, as "11 min ago" style words. `now` is passed in so a render is repeatable. */
export function agoWords(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}
