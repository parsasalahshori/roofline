# Task 03: Front Desk inbox, conversation and settings

Read `README.md` beside this brief and your exact file allowlist in `ownership.json`, key `03`. **GPT-6 Astra only**. Base `codex/ironclad-full-rebuild` from `launch-rc3` `ff772d5c`; branch `codex/ironclad-full-ui-03`. Read `AGENTS.md`, ops handoff and constraints/progress for D1; actual full source is authoritative over stale status prose.

## Visual and functional objective

Match https://roofing-os-demo.vercel.app/ faithfully while preserving every meaningful existing workflow. Controller supplies `ops/ironclad-rebuild/reference/` screenshots/notes. If browsing/assets are missing, report the gap; never claim unperformed visual QA. User request overrides historical hard-coded visual tokens/window sizing only. Security/business rules and accessibility remain.

Own presentation under features/front-desk including settings/ProfileTab, forwarding guide/test, on-call and transfer controls. Preserve inbox filters/unread, conversation summary/transcript, recording, reply and handoff links; keep retention and read-only/off semantics. Existing hooks including conversation-api/inbox-api/forwarding-api/settings-api are frozen. Timeline FrontDeskCard belongs Task 05 and appointment details Task 06; report cross-feature requests. Do not contact a real phone or send a real reply while checking.

## Ownership and contracts

Edit only manifest-listed files, your new `apps/web/test/ironclad-full-03.test.tsx` and own report; Task 10 additional paths are listed explicitly. Freeze backend/schema/providers/send-gates, all API hooks/HTTP contracts/types, and unlisted business helpers. Controller owns router/shared exports and integration. No dependency/config/lockfile edits. Preserve meaningful interactions, busy/error/empty states, RBAC, billing and demo/live guards. Cross-owner changes are requests, not unilateral edits.

## Smallest meaningful checks

d1-t21-window.test.tsx, d1-t21-week-stats.test.tsx, d1-t22-view.test.tsx, d1-t22-reply.test.tsx, d1-t23-front-desk-tab.test.tsx, d1-t23-on-call-list.test.tsx, d1-t24-guide.test.tsx, d1-t24-test.test.tsx, d1-t26-recording.test.tsx. E2E front-desk.spec.ts: open/reply using fake providers, settings/forwarding and linked job.

Run targeted existing tests plus meaningful new regressions, typecheck/lint/CSS lint/build where supported. Tests use fakes; Docker-less sessions rely on CI for stack-backed checks. Existing tests are read-only except manifest-listed token test. Never weaken coverage to hide a regression.

## Handoff

Commit and push only your task branch; no merge/main/integration/force-push. Write `ops/ironclad-rebuild/task-03-report.md`: SHA, files, preserved workflows, exact reference evidence, commands/results, real screenshots, CI links/status, gaps and integration requests. Controller waits for all outputs and CI, integrates and verifies the whole product.
