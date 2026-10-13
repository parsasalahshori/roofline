# Task 09: Account, settings container, onboarding and demo support

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `09`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-09`. Read `AGENTS.md`, ops handoff and constraints/progress for F3/F2; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

Own auth/signup/billing/imports/setup/texting/demo/coming-soon presentation, error surfaces and remaining settings container/company/team/connections. Feature-specific settings in manifest belong other tasks; preserve imported interfaces. Keep safe redirects, owner/team permissions, billing/read-only banners, trial/cost disclosures, CSV mapping/preview/consent/progress, texting registration and setup checklist. DemoBadge stays gated by server demo mode and existing simulation hook. Preserve reset/signup/invite/verification errors; no auth bypass, real sends/purchases or credential entry. Shared shell mounting is Task 01.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-09.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

auth.test.tsx, signup.test.tsx, billing.test.tsx, import-wizard.test.tsx, setup.test.tsx, texting.test.tsx, settings-company.test.tsx, settings-team.test.tsx, settings.test.tsx, demo-badge.test.tsx. E2E signup.spec.ts, billing.spec.ts, import.spec.ts, setup.spec.ts, demo-walkthrough.spec.ts via separate demo config; check real fake-backed progression, not cosmetic clickability.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-09-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
