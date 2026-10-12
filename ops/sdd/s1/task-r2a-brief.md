### Task R2a (whole-branch review): storm plans: locking, re-draft rules, pause signature

**Base:** `s1-storm`. API and db only. Files: `apps/api/src/storm/plan.ts`, `apps/api/src/storm/settle.ts`, `apps/api/src/routes/storms.ts`, `apps/api/src/jobs/handlers.ts` (storm-draft only), `packages/db/src/repos/storm-plans.ts`, `packages/db/src/repos/storm-api.ts`, and their tests. Task R1 adds `merged_into` filters in the matching repos; do not edit those functions.

**Fixes:**
1. **(important) A re-draft can overwrite an approved plan.** `replaceDraftPlan` locks only `company_storms`, reads the task status with a plain join, and declines the old task with no status guard. A concurrent approve then loses.
   - Lock the task too: `for update of cs, t`, or `getTask(..., { forUpdate: true })` first.
   - The decline UPDATE is guarded by `status = 'draft'` (and the expired/declined statuses below), and returns false when no row changed.
   - Test with two transactions, or a lock-order test.
2. **(important) Expired and declined plans can never be re-drafted.**
   - `draftStormPlan` and `replaceDraftPlan` replace `draft`, `expired` and `declined` plans; never `approved`, `running`, `awaiting_owner`, `partly_done`, `needs_attention` or `done`. Check `TASK_STATUSES` for the exact names.
   - `POST /api/storms/:id/plan` allows the same statuses.
   - The automatic settle path (`settle.ts shouldDraft`) stays draft-only, so the machine never re-drafts after the owner let a plan expire.
   - Tests for each status.
3. **Ruling BC:** `draftStormPlan` returns `{ taskId } | null`. It keeps the A1 T14 marker comment as the first thing inside the drafting transaction, where `isAgentPaused` will go, and returns null when paused. The storm-draft job ignores the value. The route answers 409 'Storm Scout is paused. Turn it back on in Agents to draft a plan.' when it gets null. On this base nothing pauses yet, so test the null branch through an injected or stubbed check only if that's natural; otherwise test the route mapping.
4. **(minor) Shared error constants.**
   - Export plan.ts's error-message constants (or typed error classes) and import them in `routes/storms.ts` instead of matching copied text.
   - The storm-draft job does not retry permanent failures (not found, dismissed): it logs them and returns.
5. **(minor) Repeated "ready" emails.** A re-draft does not re-send "Your storm plan is ready" when the previous plan for the same company storm was also a draft (`plan.ts`, around line 215). Only the first draft and a re-draft after expiry or decline alert.
6. **(minor) The storms list ignores `?since=`.** `GET /api/storms` parses `?since=` (an ISO date; 400 on garbage) and passes it to `listCompanyStorms`. With no `since`, it defaults to the last 30 days.

**Verify:** typecheck, lint, shared tests; ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(api): storm plan re-draft locks the task, replaces expired or declined plans, returns null when paused`
