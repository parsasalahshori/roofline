# Task 07: Agents, claims and agent settings

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `07`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-07`. Read `AGENTS.md`, ops handoff and constraints/progress for A1/G1; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

Own agents presentation, ClaimsBoard, job/ClaimSection and AgentsTab/AgentRules. features/claims contains only api.ts and stays frozen. Preserve pause/run-now/turn-on/rules, waiting/feed/task detail links, claims facts/packet controls and role restrictions. Time/money helpers and snapshots remain authoritative; keep about/estimate qualifiers and owner-only recount. Scheduler and Follow-up agents remain approval-driven, with stop/spacing rules untouched. No insurer contact or automatic customer sends.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-07.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

agents-card.test.tsx, agents-window.test.tsx, agent-page.test.tsx, agents-waiting.test.tsx, agent-rules.test.tsx, claims-board.test.tsx, claim-section.test.tsx, g1-turn-on.test.tsx, time-baselines.test.tsx, time-baselines-recount.test.tsx. E2E agents.spec.ts, agents-settings.spec.ts, more-agents.spec.ts: pause/run/review/rules and claims facts/packet behavior.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-07-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
