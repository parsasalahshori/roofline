# Task 01: Global design system and shell

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `01`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-01`. Read `AGENTS.md`, ops handoff and constraints/progress for F2; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

All shared UI/tokens plus shell/topbar/dock/phone. Preserve ReviewSteps props and behavior; feature approval rendering belongs to Task 08. Preserve banner-height observation, lazy/company-keyed map, Today auto-open, all unread/draft badges, recents/search/account/company switching, focus/close behavior and responsive navigation. Match exact observed geometry and visual system; publish token/inset decisions early. Task 09 owns rendered Billing/Demo components, which remain mounted through existing interfaces.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-01.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

packages/ui tests; shell.test.tsx, phone.test.tsx, top-bar.test.tsx, search-dialog.test.tsx, search-actions.test.tsx, company-switch.test.tsx, a1-dock.test.tsx. Workflows: deep links, close/Esc, search customer/job, switch company, desktop/mobile navigation. E2E shell.spec.ts, phone.spec.ts, a11y.spec.ts.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-01-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
