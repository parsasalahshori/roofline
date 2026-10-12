import type { TaskStatus } from '@roofline/shared';

/*
 * Shared by plan.ts (throws them), routes/storms.ts (maps them to HTTP) and jobs/handlers.ts (storm-draft
 * logs and drops the permanent ones). Compare thrown errors with `err.message === CONSTANT`.
 */
export const PLAN_NOT_FOUND = 'We could not find that storm.';
export const PLAN_DISMISSED = 'This storm was dismissed, so no plan is drafted.';
export const PLAN_CHANGED = 'The plan changed while we were drafting. Please try again.';
export const PLAN_PAUSED = 'Storm Scout is paused. Turn it back on in Agents to draft a plan.';
export const PLAN_EXISTS = 'This storm already has a plan. Open it in your tasks.';

/**
 * Plan task statuses a new draft may replace on s1-storm: a draft only. Ruling BD: A1 owns the re-draft
 * mechanism and widens this to expired and declined (lockStormPlan / supersedeDraft) at its s1 merge.
 */
export const REDRAFTABLE_PLAN_STATUSES: readonly TaskStatus[] = ['draft'];
