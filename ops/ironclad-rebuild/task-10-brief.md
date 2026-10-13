# Task 10: Contract audit and cross-product regression QA

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `10`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-10`. Read `AGENTS.md`, ops handoff and constraints/progress for all milestones; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

Read all production/frontend/backend code as needed but edit NO production code. Own new contract regression test, new Playwright cross-product regression spec and qa artifacts only. Inventory actual routes/actions/RBAC/demo guards, baseline hook signatures and meaningful workflow coverage. Audit component changes for lost functionality and any contract drift; request separately reviewed fixes through controller. Validate isolated demo text/call/storm/sign simulations, company switches, read-only/RBAC and approval/quote/sign/booking flows with existing fake/local helpers. Never run real-provider manual smoke scripts or modify seeds/configs to make tests pass.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-10.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

Run focused new tests and relevant existing suites; record baseline versus integration outcomes distinctly. Verify all five CI areas: Platform, E2E including demo, v1, Demo DB arm64, Hail. Without Docker list Playwright tests and rely on CI for stack-backed runs. Screenshot comparison requires actual provided reference/runtime evidence; report exact artifact paths and unresolved workflows.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-10-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
