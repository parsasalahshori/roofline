# Task 08: Approvals, storm and door routes

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `08`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-08`. Read `AGENTS.md`, ops handoff and constraints/progress for F2/S1/G1/E1; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

Own approval screens/step-preview presentation, storm screens/door routes and StormTab/AdConnections. Shared ReviewSteps belongs Task 01. Freeze approval editing/polling/conversion helpers, step payload/registry/types and storm route validation/navigation/API helpers. Preserve approval classes/canApprove, per-step version/pending locks, 409 reconciliation, decline/retry/rerun and expiry. Keep radar-estimated hail labels, budgets/consent/opt-outs, plan links/results, door outcomes and wants-check lead flow. No invented success or real ad spend/messages.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-08.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

review.test.tsx, approval-sheets.test.tsx, step-fields-sheet.test.tsx, step-ads.test.tsx, step-texts.test.tsx, step-visits.test.tsx, step-routes.test.tsx, storm-detail.test.tsx, storm-results.test.tsx, door-outcome.test.tsx, route-view.test.tsx, settings-storm.test.tsx. E2E approvals.spec.ts, storm.spec.ts, doors.spec.ts; preserve fake send and spend gates.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-08-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
