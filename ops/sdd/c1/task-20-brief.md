### Task 20: Web: job window

**Base:** `c1-crm` after Tasks 18 and 19 are merged. From T19: `useMoveJob`, `MoveJobMenu`, `MoveJobSheet` (`features/jobs/*`), `<Timeline jobId />` (`features/timeline/Timeline.tsx`) — import, do not edit. From T18: `useRecordRecent` (`shell/recents.ts`), placeholders `features/job/{JobWindow,api}`, `copy/job.ts`. From T4: `JobView`. API: `GET /api/jobs/:id/view`, `PATCH /api/jobs/:id` (T6).

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `JobWindow.tsx` header, stage stepper, edit sheet; Builder 2 sections (appointments, quotes, agent tasks, the imported `Timeline`); Builder 3 `copy/job.ts`, `features/job/api.ts`, tests.

**Files:**
- Create: `apps/web/src/features/job/{JobHeader,StageStepper,EditJobSheet,JobSections}.tsx`
- Modify: `apps/web/src/features/job/{JobWindow.tsx,api.ts}`, `apps/web/src/copy/job.ts`
- Test: `apps/web/test/job-window.test.tsx`

**Interfaces:**
- **Hooks:** `useJobView(id)` (`['job', id]`, `GET /api/jobs/:id/view`); `useUpdateJob(id)` (PATCH value/source/rep/next step; invalidates `['job', id]` and `['jobs-board']`); `useArchiveJob(id)`. Calls `useRecordRecent({ kind: 'job', id, label })` (Task 18's `shell/recents.ts`).
- **Window:** `AppWindow app="jobs"` with the stat strip: stage label, `job.value` (when visible), `job.daysInStage`. Header: customer link (`/customers/:id`), address link (`/?focus=<propertyId>`), `StageStepper` (five open stages, current highlighted, Lost shown as a state chip; clicking a stage moves via Task 19's `useMoveJob`/`MoveJobSheet`), `MoveJobMenu`, rep `Select` (members + Unassigned; reps see only themselves + Unassigned), next step line with "Edit".
- **Sections:** Appointments (`AppointmentView` list with time, kind, person; buttons "Book inspection" → `/calendar/new?jobId=<id>&kind=inspection`, "Book install" → `…&kind=install`); Quotes (`QuoteSummary` rows → `/jobs/:id/quotes/:quoteId`; "New quote" → POST then navigate); Agent tasks (links to `/approvals/:taskId`); Timeline (`<Timeline jobId=… />`).
- **Edit sheet:** value (dollars), source, next step text + date; archive/restore with a confirm.

**Tests:**
- renders the view; a rep sees no value; stepper click to Proposal sends PATCH; Lost via stepper opens the sheet; Book inspection link URL; the timeline mounts with `jobId`; 404 → the Not found empty state.

**Carries and rulings:**
- Do not edit `features/jobs/*` or `features/timeline/*` (T19's).

**Verify notes:**
- web suite, lint, typecheck, build.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): job window with stage stepper, appointments, quotes and the timeline`
