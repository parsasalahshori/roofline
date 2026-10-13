# Task 06: Calendar, appointments and scheduling settings

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `06`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-06`. Read `AGENTS.md`, ops handoff and constraints/progress for C1/D1; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

Own calendar/appointments presentation plus ScheduleTab, WorkHoursEditor and CalendarConnection. Preserve day/week/agenda, people filter, scheduling forms, suggestions/conflicts, create/edit/cancel, company-local time/DST and provider reconnect indicators. Freeze calendar/time.ts, feature types/hooks and crm-api. Do not modify agents Scheduler (Task 07), Front Desk (Task 03) or Today (Task 02). All routes/links retain identity and deep-link behavior. No real provider booking or OAuth credentials.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-06.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

calendar.test.tsx, appointments.test.tsx, appointments-form.test.tsx, appointments-suggest.test.tsx, settings-schedule.test.tsx, calendar-connection.test.tsx, d1-t26-appointment.test.tsx. Workflows: view selection/filter, suggestions/conflict warning, appointment save/cancel and work hours. E2E calendar.spec.ts with fake providers.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-06-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
