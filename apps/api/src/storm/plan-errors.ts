import { MESSAGES } from '../errors.ts';

/*
 * Shared by plan.ts (throws them), routes/storms.ts and routes/approvals.ts (map them to HTTP) and jobs/handlers.ts
 * (storm-draft logs and drops the permanent ones). Compare thrown errors with `err.message === CONSTANT`.
 * Which plan statuses a new draft may replace is not here: REDRAFTABLE_PLAN_STATUSES (['draft'], the automatic
 * path) and FINISHED_REDRAFTABLE_PLAN_STATUSES (['expired', 'declined'], a person's explicit re-draft) live in
 * @roofline/db (repos/storm-plans.ts) as the one source of truth (amended Ruling BD).
 */
export const PLAN_NOT_FOUND = 'We could not find that storm.';
export const PLAN_DISMISSED = 'This storm was dismissed, so no plan is drafted.';
export const PLAN_CHANGED = 'The plan changed while we were drafting. Please try again.';
/** The same sentence the agents rerun route answers (MESSAGES.stormScoutPaused). */
export const PLAN_PAUSED = MESSAGES.stormScoutPaused;
export const PLAN_EXISTS = 'This storm already has a plan. Open it in your tasks.';
