### Task 6: Jobs: stage rules, next step, board and job view

**Base:** `c1-crm` after Tasks 1, 2, 4 and 5 are merged. From F1/F2 (`packages/db`): `getJob`, `listJobs`, `createJob`, `updateJob`, `setJobArchived`, `JobInput`, `JobPatch`, `JobLinkError` (`repos/jobs.ts`); `jobScope`, `canSeeJobValue` (`repos/scope.ts`); `customerMatch`, `escapeLike` (`repos/search.ts`); `addActivity` (`repos/activities.ts`); `audit` (`repos/audit.ts`); `company_members` view (raw SQL). From the API: `routes/jobs.ts` (existing `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `POST /:id/<action>`), `can`, `requireCapability` (`permissions.ts`). From T2: `stageMoveProblem`, `daysInStage`, `isStuck`, `NEXT_STEP_MAX`, `BOARD_STAGES`. From T4: `JobCard`, `BoardView`, `BoardColumn`, `JobView`. From T5: placeholders `listAppointmentsForJob`, `listQuoteSummaries` (Ruling 4). Test seed: `seedShowcase` (8/7/6/4/2/1 by stage).

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:**
- Builder 1: `packages/db/src/repos/jobs.ts` (rules hook-in, next step) and `packages/db/src/repos/board.ts`.
- Builder 2: `apps/api/src/routes/jobs.ts` (`/board`, `/:id/view`, PATCH body additions, messages).
- Builder 3: `apps/api/test/{jobs-board,jobs-stage-rules,job-view}.test.ts`.

**Files:**
- Modify: `packages/db/src/repos/jobs.ts`, `packages/db/src/repos/board.ts`, `apps/api/src/routes/jobs.ts`
- Test: `apps/api/test/jobs-board.test.ts`, `apps/api/test/jobs-stage-rules.test.ts`, `apps/api/test/job-view.test.ts`

**Interfaces:**
- **`JobInput`/`JobPatch` gain** `nextStep?: string | null` (trimmed, ≤ `NEXT_STEP_MAX`), `nextStepOn?: string | null` (`YYYY-MM-DD`). Setting or clearing them writes an activity "Next step: <text> (Oct 14)" / "Next step cleared".
- **Stage rules in `updateJob`:** before writing, `stageMoveProblem({ from: before.stage, to, valueCents: patch.valueCents ?? before.valueCents, lostReason: patch.lostReason ?? before.lostReason })`; a problem throws `StageRuleError(problem)` (new, exported). `createJob` applies the same rules with `from: 'lead'` when `stage` is given.
- **Route messages** (constants in `routes/jobs.ts`): `installed_needs_won` → 400 field `stage` "Mark the job Won first."; `lost_needs_reason` → 400 field `lostReason` "Pick why the job was lost."; `won_needs_value` → 400 field `valueCents` "Enter the job value to mark it Won."; next step too long → field `nextStep` "Keep the next step under 120 characters."; bad date → field `nextStepOn` "Please pick a date.".
- **Board (`repos/board.ts`):**
```ts
export type BoardFilter = { assigned?: 'me' | 'unassigned' | { userId: string }; source?: JobSource; q?: string; archived?: boolean };
export async function boardColumns(tx: Tx, ctx: TenantContext, f: BoardFilter, opts: { now: Date; timeZone: string; stuckAfterDays: number; perColumn: number; showTotals: boolean }): Promise<BoardView>;
export async function boardColumnPage(tx: Tx, ctx: TenantContext, f: BoardFilter, stage: BoardStage, offset: number, opts: …same…): Promise<BoardColumn>;
```
  - `jobScope(ctx)` applied; archived excluded unless `archived`; `installed` limited to `stage_changed_at >= now − 30 days`; ordered by `stage_changed_at desc, id`; `q` matches customer name or address with the F2 `customerMatch`/`escapeLike` helpers (`repos/search.ts`); `totalCents` = sum of `value_cents` over the whole filtered column (not the page) when `showTotals`, else null; `valueCents` per card through `canSeeJobValue`; member names from `company_members`.
- **Routes:**
  - `GET /api/jobs/board?assigned=me|unassigned|<uuid>&source=&q=&archived=true|false[&stage=&offset=]` → `BoardView`, or one `BoardColumn` when `stage` is given. `showTotals` = `can(ctx, 'view_money_totals')`. The company zone and `stuck_after_days` come from `companies`/`company_settings`.
  - `GET /api/jobs/:id/view` → `JobView` (404 when out of scope). `appointments` and `quotes` come from `listAppointmentsForJob` and `listQuoteSummaries`, Task 5's placeholders returning `[]` until Tasks 8 and 15 replace their bodies (Ruling 4). `tasks` = `agent_tasks` with `subject_type='job' and subject_id=id`, newest first, 10.
  - `PATCH /api/jobs/:id` accepts `nextStep`, `nextStepOn`; the rules errors above.

**Tests:**
- (`makeTestApp`, `seedShowcase` for Acme):
- `jobs-board.test.ts`: `test('the showcase jobs land in their columns with counts')` (lead 8, inspection 7, proposal 6, won 4, installed 2 within 30 days, lost drawer 1 — with the showcase's `stage_changed_at` = seed time); `test('totals for owner and office, none for reps')`; `test('a rep sees their jobs and unassigned leads only')`; `test('installed jobs older than 30 days leave the board')`; `test('paging a column')` (perColumn 50 vs `?stage=lead&offset=…` with 60 leads); `test('filters by assignee, source and text')`; `test('stuck cards')` (clock +15 days); `test("company B's board never shows A's jobs")`.
- `jobs-stage-rules.test.ts`: each rule through `PATCH /api/jobs/:id` with the exact message and field; `lead→won` with a value succeeds; reopening a lost job clears the reason; the activity and audit rows for a move.
- `job-view.test.ts`: owner sees value and `can.edit`; a rep on an unassigned lead sees `valueCents: null` and `can.seeValue false`; out-of-scope → 404; tasks listed.

**Carries and rulings:**
- Register `GET /board` **before** F1's `GET /:id` in `routes/jobs.ts` (F1's `/:id` validates a UUID and would answer 400/404 for `board`).
- `can(ctx, 'view_money_totals')` works because `TenantContext` is a `Member` (`role`, `canApproveSpend`).
- Member names come from the `company_members` view through raw SQL in `repos/board.ts`.

**Verify notes:**
- CI via `ops/bin/ci-check`; locally typecheck, lint.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(jobs): stage rules, next step, the pipeline board and the job view`
