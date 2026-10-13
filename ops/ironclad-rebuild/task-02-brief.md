# Task 02: Home map and Today

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `02`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-02`. Read `AGENTS.md`, ops handoff and constraints/progress for F2/C1/E1/D1/S1; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

Own map presentation, mapStyle.ts, HailLegend and Today. Preserve real geographic pins/bounds/clusters/service area, focus targets, storm layers, legends/attribution and no-network fallback; geometry/layer business helpers are frozen. Preserve Today real appointments, follow-ups, Front Desk items, signed proposals, role-scoped totals and company timezone. Do not edit auto-open/hooks or copy/proposals.ts (Task 04). Existing business data must remain visible with meaningful links.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-02.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

map-view.test.tsx, map-style.test.ts, map-focus.test.tsx, map-resilience.test.tsx, hail-legend.test.tsx, today.test.tsx, today-crm.test.tsx, today-front-desk.test.tsx, e1-today-signed.test.tsx. Workflows: map selection to job/customer, hail legend, Today to appointment/review/proposal. E2E today.spec.ts and shell.spec.ts.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-02-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
