### Task 19: Web: pipeline board and list

**Base:** `c1-crm` after Tasks 2 and 18 are merged (API Tasks 6 and 7 for the real endpoints; unit tests stub `fetch`). From T18: placeholders `features/jobs/{JobsWindow,JobsTabs,api}`, `copy/jobs.ts`. From T2: `BOARD_STAGES`. From T4: `BoardView`, `BoardColumn`, `JobCard`, `TimelineItem`, `TimelinePage`. From F2: `apiFetch`, `ApiError` (`api/client.ts`), `useIsPhone` (`shell/useIsPhone.ts`), `copy/status.ts` (`AGENT_LABEL`, message status words), kit `Select`, `Sheet`, `Field`, `Toggle`, `Avatar`, `UiLink`, `useToast`. `GET /api/team` lists members for any signed-in member (F1); the UI shows the assignee list to owner/office only.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `Board.tsx`, `BoardColumn.tsx`, `JobCardView.tsx` (drag and drop), `BoardFilters.tsx`; Builder 2 `MoveJobMenu.tsx`, `MoveJobSheet.tsx` (lost reason, value), `JobsList.tsx`, `copy/jobs.ts`, `features/jobs/api.ts` (`useMoveJob`); Builder 3 the shared timeline (`features/timeline/{Timeline,NoteComposer,api}.tsx|ts`, `copy/timeline.ts`, imported by Tasks 20 and 21) and the tests.

**Files:**
- Create: `apps/web/src/features/jobs/{Board,BoardColumn,JobCardView,MoveJobMenu,MoveJobSheet,JobsList,BoardFilters}.tsx` (+ CSS Modules), `apps/web/src/features/timeline/{Timeline,NoteComposer,api}.tsx|ts`, `apps/web/src/copy/timeline.ts`
- Modify: `apps/web/src/features/jobs/{JobsWindow.tsx,api.ts}`, `apps/web/src/copy/jobs.ts`
- Test: `apps/web/test/jobs-board.test.tsx`, `apps/web/test/timeline.test.tsx`

**Interfaces:**
- **Hooks (`features/jobs/api.ts`):** `jobsKeys = { board: (f) => ['jobs-board', f] as const, column: … }`; `useBoard(filter: BoardFilterParams)`; `useBoardColumnPage(stage, filter, offset)`; `useMoveJob()` → mutation `({ jobId, to, valueCents?, lostReason? })` = `PATCH /api/jobs/:id`, optimistic on every cached board (move the card, fix counts), rollback + toast the API message on error, invalidate `['jobs-board']` and `['job', jobId]` on settle. Exported for Task 20.
- **`MoveJobMenu({ job, onMoved? })`:** a kit `Select` labelled `jobs.moveTo` "Move to…" listing the other stages (labels from `jobs.stage`) — choosing Lost or Won (without a value) opens `MoveJobSheet`; Installed is listed only when the job is Won (Decision 2, rule 3). `MoveJobSheet({ job, to, onDone })`: Lost → a `Select` of the six reasons (`jobs.lostReasons`: "Price", "Went with another roofer", "Insurance denied the claim", "No damage found", "Stopped responding", "Not ready yet", "Other") plus a `Field` for Other; Won → a money `Field` "Job value" (dollars → cents). Exported for Task 20.
- **Board:** columns from `BOARD_STAGES` with header `jobs.columnHeader(label, count)` and the total (`jobs.total(dollars)`) only when `totalCents !== null`; the Lost drawer `jobs.lostDrawer(count)` toggles a list. Cards are `UiLink`s to `/jobs/:id` with `draggable`; dropping on a column calls `useMoveJob` (or opens the sheet); each card also renders `MoveJobMenu` (compact). `data-stage`, `data-stuck` attributes. "Show N more" per column.
- **Card text:** name, address, `jobs.value(dollars)` when visible, rep (`Avatar` + name or `jobs.unassigned`), `jobs.daysInStage(n)` ("3 days"), `jobs.stuck(n)` ("Stuck 15 days"), next step `jobs.nextStep(text, date)`.
- **Filters** (`BoardFilters`): assignee `Select` (`jobs.filterAll`, `jobs.filterMine`, `jobs.filterUnassigned`, each member from `GET /api/team` — rep sees no member list), source `Select`, a text `Field` (debounced 300 ms), "Show archived" `Toggle`; all mirrored in the URL (`useSearchParams`). Buttons "New job" (`/jobs/new`) and "Download jobs" (owner/office → `/api/export/jobs.csv`, a plain anchor with `download`).
- **Timeline (`features/timeline`):** `<Timeline customerId? jobId? />` — items newest first (`useTimeline`, an infinite query on `before` over `GET /api/timeline`); activity rows with actor and relative time ("2 hours ago", absolute in `title`); text rows as chat bubbles (in/out) with status words from `copy/status.ts`; "Show older"; `NoteComposer` (multiline `Field`, 2,000 max with a counter, "Add note" → `useAddNote` = `POST /api/notes`, prepends the returned item). Words in `copy/timeline.ts`.
- **List view** (`?view=list`, and always on phone via `useIsPhone`): a table (desktop) or stacked rows (phone) with stage chips; sorted by stage then updated; each row has `MoveJobMenu`.

**Tests:**
- timeline renders items newest first, "Show older" sends `before`, a note posts and appears at the top, 2,001 characters is refused; columns and counts from a stubbed `BoardView`; totals shown for owner, hidden when null; drag a card from Lead to Inspection → PATCH `{ stage: 'inspection' }` and the card is in the new column before the response; a 400 rolls back and toasts; Move to → Lost opens the sheet and sends `{ stage: 'lost', lostReason: 'Price' }`; Won without a value asks for it; Installed not offered unless Won; filters update the URL and the request; phone shows the list.

**Carries and rulings:**
- `useMoveJob`, `MoveJobMenu`, `MoveJobSheet` and `features/timeline/*` are exported for T20/T21, which import them and never edit them.

**Verify notes:**
- `npx vitest run --project @roofline/web jobs-board`, lint, typecheck, build.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): pipeline board with drag, a Move-to menu, filters and a list view`
