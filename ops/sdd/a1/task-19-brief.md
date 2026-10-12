### Task 19 (track lead): S1's draft replacement goes through the task service (Ruling AX-H)

**Base:** `a1-agents` after the e1+s1 upstream merge (56b43da).

**Problem (integration review):** `packages/db/src/repos/storm-plans.ts` `replaceDraftPlan` (S1) supersedes an old storm-plan draft by moving its pending/awaiting_owner steps to `skipped` (`moveStep`) and setting the task `declined` (`updateTask`, reason 'Replaced by a newer plan.') outside `apps/api/src/tasks/service.ts`. No event is written, so the feed never shows it and the one-writer rule is broken.

**Do:**
1. Add `supersedeDraft(tx, ctx, oldTaskId, newTaskId, now)` to `tasks/service.ts`: lock the old task; only if it is still a `draft`, skip its pending/awaiting_owner steps, set it `declined` (no user, reason 'Replaced by a newer plan.'), and write exactly one `declined` event with actor `system` and data `{ skippedSteps, replacedByTaskId }` (ids and counts only), all in the caller's transaction. Return whether it superseded.
2. Split `replaceDraftPlan`: the db repo keeps only the `company_storms` lock/check and the link update (returning the old draft id it found, or the same false/true contract S1's caller needs); `apps/api/src/storm/plan.ts` calls `supersedeDraft` from the service between the two, inside the same transaction, keeping S1's behaviour and error (`CHANGED`) exactly.
3. Feed text (`apps/api/src/agents/feed-text.ts`): a system `declined` event with `replacedByTaskId` reads "{Agent} replaced {title} with a newer plan".
4. Ruling AX-O (track lead): a superseded draft counts as "Not approved" in the 30-day numbers like any declined draft (it was never approved); no metrics change.
5. Guard: add `moveStep` and `updateTask` to the ESLint one-writer restriction only if every remaining production caller is in `tasks/service.ts` (grep first; if other callers exist that are legitimate F1/F2 paths, leave the rule and list them in the report).

**Tests (db-backed, CI only):** S1's existing storm-plan replacement tests stay green; a re-draft writes one `declined` system event on the old task with `replacedByTaskId`; a non-draft old plan is not superseded (S1's CHANGED path); feed-text test for the sentence.

**Files:** `apps/api/src/tasks/service.ts`, `packages/db/src/repos/storm-plans.ts`, `apps/api/src/storm/plan.ts`, `apps/api/src/agents/feed-text.ts`, `eslint.config.js` (maybe), their tests.

Commit: `fix(api): storm draft replacement through the task service with a feed event`
