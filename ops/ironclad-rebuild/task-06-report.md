# Task 06 — Calendar, appointments and scheduling

Branch: `codex/ironclad-full-ui-06`

Implementation commits:
- `00a7cc14d0d40332f58e7d5cc78002c7da49214b` — calendar, appointment and settings presentation plus seven regressions.
- `bab22408f0e615b2dc572579229041bcf969fd4c` — 44px phone time-grid rows and 40px all-day targets; time calculations unchanged.

Verified base: `81b9251490cfa05eac4baecc68f6952b549a1460`, with complete-app `ff772d5cbf87eac051759e9049fb29930845a45f` ancestry verified before branching. The initial clean checkout was the old `work` branch at `46c6e1f`; no work was done against it. Supported per-command network permission recovered fetch, npm, Docker, E2E and push; proxy and network policy were not modified. No extra agents/sessions were spawned.

## Changes and preserved workflows

- Neutral near-white scheduling workspace, compact segmented Week/Day/List controls, rounded grid, lighter appointment fills, colored edges and current-day highlight. Desktop summary is derived only from the existing filtered appointment result; count, errors, canceled visibility and no-person-selected states are truthful. Summary opens existing detail routes and keeps date/people deep links when switching to List.
- Phone defaults to the existing agenda. People filtering is expandable; agenda rows expose the real address, assignee and status. Explicit Week/Day views retain scrollable columns and get touch-sized rows. Grid event accessible names include their customer, company-zone time range and address even when the visual card is short.
- Appointment entry/detail/suggestions use coordinated neutral cards and legible spacing. Appointment form explicitly names the company timezone. Work-hours rows are compact on desktop and adapt at phone widths. Company/personal hours and external calendar connection panels have matching surfaces.
- All existing scheduling kinds, slot suggestions, conflict Keep it/Change time, create/PATCH/cancel/complete/no-show, install date ranges, Front Desk attribution, provider failure/retry/reconnect/disconnect, owner/rep permissions and company-zone/DST behavior remain wired to the original implementations.
- No API hooks, HTTP contracts, backend/provider/database/worker/send-gate code, time helpers, feature types, routing, shared exports, dependency/lock/config files or existing tests were changed. No live provider actions, OAuth credentials, real messages, production changes, main/integration pushes or merges.

## Exact file scope

All source changes are in ownership key `06`:

- `apps/web/src/copy/{appointments,calendar,schedule}.ts`
- `apps/web/src/features/appointments/{AppointmentDetail.module.css,AppointmentForm.module.css,AppointmentForm.tsx,SuggestedTimes.module.css}`
- `apps/web/src/features/calendar/{AgendaView.module.css,AgendaView.tsx,CalendarToolbar.module.css,CalendarToolbar.tsx,CalendarWindow.module.css,CalendarWindow.tsx,PeoplePicker.module.css,PeoplePicker.tsx,TimeGrid.module.css,TimeGrid.tsx}`
- `apps/web/src/features/settings/{CalendarConnection.module.css,ScheduleTab.module.css,ScheduleTab.tsx,WorkHoursEditor.module.css}`
- `apps/web/test/ironclad-full-06.test.tsx`
- This report.

Manifest comparison passed for all 22 implementation/test paths, and `git diff --check` passed. No existing regression assertions were edited.

## Reference and visual evidence

Inspected the committed `reference/schedule-1440x900.jpg` and `reference/front-desk-phone-390x844.jpg`, plus `reference/README.md` and computed front-desk metrics. Schedule evidence shows the near-white workspace, white rounded grid and right panel, fine gray dividers, compact text and tinted event cards with colored edges. Recorded shared reference measurements include #f6f7f8 window background, 18px window radius, 16px heading and compact 28–36px desktop controls. The task uses those surfaces and density while retaining the actual appointment/time-grid model.

The reference has crew rows, weather risk, material drops and homeowner texts that are not exposed by task 06's frozen appointment contracts. Those synthetic figures/workflows were not copied. The actual appointment summary occupies the right panel. Scheduler/weather/communications remain with their existing owners. This is not a claim of pixel-exact integrated fidelity.

Before/after Chromium captures were obtained at 1440×900 and 390×844 for calendar, appointment entry, work hours and calendar connection. Baseline captures used the untouched baseline web build; after captures use the redesigned build. Visual review confirms neutral surfaces, clearer appointment detail, compact desktop work hours and readable phone content. No page-level horizontal overflow or page JavaScript errors was observed in the capture checks. Internal week-grid horizontal scrolling remains intentional.

Artifacts are local scratch evidence at `/workspace/work/task06/screenshots/`:
- `task06-before-{calendar,appointment,hours,connection}-{desktop,phone}.png`
- `task06-after-{calendar,appointment,hours,connection}-{desktop,phone}.png`
- `task06-before-visual-checks.json`, `task06-after-visual-checks.json`
- `task06-after-detail-{1440,390,375}.png`, `task06-audit.json`

A final browser audit on `bab22408` checked detail at 1440×900, 390×844 and 375×844: zero scoped Axe WCAG A/AA violations. It also verified phone Week-view slots are at least 40px high and clicking 09:30 still prefills 09:30 in company time, with no page overflow. This scoped check is not a whole-application accessibility certification.

Captures use seeded test-company data and fake providers. They are not committed because screenshot paths are outside this task's exclusive allowlist. The designated chat output root could not be created in this executor (`/codex` is on a read-only filesystem). The controller can reproduce/copy the scratch evidence or recapture after integration.

## Checks actually run

| Check | Result |
| --- | --- |
| `npm ci --cache /workspace/roofline/work/npm-cache` (cache subsequently moved outside the repo) | Passed, 858 packages; first attempt at default home cache failed with ENOENT and was retried using workspace cache. No lockfile change. |
| `npm ls playwright-core` | Only 1.56.1 |
| Baseline scoped web suites | 7 files / 70 tests passed |
| Final scoped web suites including own regression | 8 files / 77 tests passed |
| Calendar + own regressions after phone row-size follow-up | 2 files / 37 tests passed |
| `npm run typecheck` | Passed after final source change |
| `npm run lint` | Passed after final source change |
| `npm run lint:css` | Passed after final source change |
| `npm run build:web` | Passed after final source change; existing >500kB bundle warning remains |
| Docker-backed scheduling API suites | 5 files / 90 tests passed |
| Existing `e2e/calendar.spec.ts` against disposable API/worker/PostGIS with fake providers | Before the phone-row follow-up, 4 passed: both existing specs at 1440×900 desktop and 390×844 phone |

Scoped web files: `calendar.test.tsx`, `appointments.test.tsx`, `appointments-form.test.tsx`, `appointments-suggest.test.tsx`, `settings-schedule.test.tsx`, `calendar-connection.test.tsx`, `d1-t26-appointment.test.tsx`, `ironclad-full-06.test.tsx`.

Docker-backed command: `npx vitest run --project @roofline/api apps/api/test/appointments.test.ts apps/api/test/calendar-connect.test.ts apps/api/test/calendar-push.test.ts apps/api/test/calendar-pull.test.ts apps/api/test/schedule-settings.test.ts`.

Browser checks used the existing `apps/web/e2e/stack.ts` and a scratch Playwright config importing the repository config, reusing that isolated stack and running the unchanged calendar spec for both viewports. Browser executable: `/usr/bin/chromium`; Playwright package pinned at 1.56.1. The committed phone project normally targets phone/doors specs, so this explicit scratch project also exercised calendar at phone size. The four tests prove three-click booking plus actual lead-stage movement and fake provider connect/outbound sync. They do not prove live OAuth or inbound sync from a real provider; the API pull suite supplies fake-backed inbound coverage.

New regression cases cover truthful filtered sidebar/count/route behavior, canceled/no-selection transitions, date/people preservation into List, full accessible event names, phone agenda details/filter disclosure, read errors without fabricated zero counts and company-time slot prefill.

## CI and remaining integration gates

Latest implementation CI: https://github.com/parsasalahshori/roofline/actions/runs/38334595175 — head `bab22408f0e615b2dc572579229041bcf969fd4c`. At 2026-10-12 18:59 PDT all five required jobs were **queued**, not passed: Platform; E2E; v1; Demo DB (arm64); Hail service. The earlier run https://github.com/parsasalahshori/roofline/actions/runs/38334342198 for `00a7cc14` was canceled by the workflow's branch concurrency when the phone-target follow-up was pushed. This report-only commit is excluded by CI paths-ignore; the implementation SHA above identifies the relevant source run.

CLI access to `api.github.com` was forbidden by the configured proxy policy. CI metadata was read through the connected GitHub tools, without changing the policy. Full product suites, demo walkthrough, ARM64 and Hail were not claimed as local executions. The controller must wait for the actual CI results and repeat integrated checks.

Cross-owner requests / gaps:
1. Task 01/controller: apply the shared Archivo-compatible font, near-full desktop window geometry (reference x20/y42/w1400/h766 at 1440×900), header/dock/map surfaces and phone shell. Current captures intentionally retain baseline shared shell; no task-owned CSS reaches into it.
2. Task 09/controller: integrate these Schedule/Connection panels into the redesigned settings container, then verify its own tabs/scrolling at 375 and 390px. No shared settings container or copy was edited.
3. Task 07/controller: reconcile the reference crew/weather/material/text dashboard with the existing Scheduler surface in its own scope. Do not fabricate it inside the frozen appointments screen.
4. Reference set has no dedicated phone-calendar or appointment/settings screenshots. Their responsive adaptation follows the supplied phone visual system, but exact screen-to-screen comparison needs controller evidence.
5. Live-provider readiness remains an owner smoke-test concern. This task establishes scoped implementation and the local automated evidence above, not whole-product readiness.
