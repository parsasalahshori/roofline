# Task 05: CRM jobs, customers, creation and timeline

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `05`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-05`. Read `AGENTS.md`, ops handoff and constraints/progress for C1/D1/E1; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

Own jobs/job/customers/create/timeline UI except job/ClaimSection (Task 07). Preserve board/list filters, stage moves and required transition inputs, job/customer create/edit, address/home linking, assignees, next steps, archived/read-only states, notes/timeline and proposal/calendar/FrontDesk/claims links. Keep rep scope and hidden job money. Do not change shared create/hooks or invent temporary successful records. Preserve imported ClaimSection and all existing child component interfaces.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-05.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

jobs-board.test.tsx, job-window.test.tsx, customers-list.test.tsx, customer-window.test.tsx, customer-edit.test.tsx, create-job.test.tsx, create-customer.test.tsx, timeline.test.tsx, d1-t26-timeline.test.tsx, e1-job-proposals.test.tsx. E2E crm.spec.ts: create customer/job, board move, detail/edit, note and role restrictions.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-05-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
