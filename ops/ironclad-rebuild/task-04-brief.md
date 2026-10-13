# Task 04: Estimator, measurements, quotes and homeowner proposals

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `04`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-04`. Read `AGENTS.md`, ops handoff and constraints/progress for E1; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

Own estimator/measure/quotes/proposals/homeowner presentation and estimator settings listed in manifest. OutlineEditor.ts, draft.ts, handoff/format/types/hooks remain frozen. Preserve instant-versus-exact labels, measurement outline editing interaction, option selection, quote line/totals, cents arithmetic through existing helpers, save/version errors, send approvals, downloads and public signing/decline consent. Public page remains session-free without third-party scripts; homeowners must not gain unit-price visibility. No paid exact-report or real proposal sends.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-04.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

estimator.test.tsx, measure.test.tsx, quote-editor.test.tsx, proposal-window.test.tsx, proposal-option-card.test.tsx, homeowner.test.tsx, settings-prices.test.tsx, settings-estimator.test.tsx. Workflows: measurement to quote to proposal, choose option, sign/decline and error states. E2E estimator.spec.ts and homeowner.spec.ts with fakes.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-04-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
