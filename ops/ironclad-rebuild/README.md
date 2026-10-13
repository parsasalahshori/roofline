# Ironclad full-product frontend rebuild

Base: verified `origin/launch-rc3` at `ff772d5c`; integration branch `codex/ironclad-full-rebuild`. This supersedes the F2-only rebuild plan. Actual router/source includes CRM, calendar/appointments, estimator/measurement/quotes/proposals, public homeowner signing, Front Desk, agents/claims, storm/door routes, approvals and onboarding/billing/imports/demo. Do not revert these functioning workflows to placeholders.

## Authority and scope

**GPT-6 Astra only** for every session and any explicitly authorized delegation. User instruction supersedes legacy Claude staffing instructions; application provider configuration is unchanged. Read `AGENTS.md`, `ops/README.md`, relevant milestone constraints/progress and actual code. Historical milestone-status text may be stale; actual code establishes capabilities. User's faithful Ironclad request overrides previous hard-coded visual tokens and window sizing, not security/business/accessibility rules.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller will commit screenshots/assets under `ops/ironclad-rebuild/reference/` plus reference notes. Use those and observed live states. If cloud browsing or assets are unavailable, report evidence gaps and continue grounded work; never invent measurements or claim visual QA occurred. Preserve real data and meaningful controls while matching layout, density, typography, surfaces and navigation. Usability enhancements within existing contracts are permitted. Never fabricate live statistics, replace mutations with toasts/local simulations, or remove inconvenient features to match a screenshot.

## Frozen boundaries

No backend/worker/database/schema/migration/provider/send-gate changes. Freeze all HTTP hooks/contracts: `apps/web/src/api/**`, every `api.ts`, `*-api.ts`, `*Api.ts`, feature types and business helpers. UI event wiring can improve, but must call existing hooks with identical contract/permission semantics. Keep company isolation, RBAC, rep money visibility, approval class/version/pending/409 semantics, billing/read-only rules, consent, unsubscribe, paid-action guards and demo/live isolation. No real messages, spend, credentials or accounts; tests use fakes. Do not read/print secrets or commit customer data.

Controller exclusively owns `app/router.tsx`, `app/providers.tsx`, `main.tsx`, `shell/apps.ts`, shared export/index files and shared copy `common.ts`, `errors.ts`, `legal.ts`, `status.ts`. Other unlisted files are read-only. No dependencies/lockfile/config edits. Clean cloud checkout may use `npm ci` without changing dependency files. CSS Modules, centralized copy, shared controls, strict TypeScript, 12px floor, AA contrast and phone touch/focus requirements remain.

## Ownership and workflow

`ownership.json` is the exact exclusive write allowlist; new test/report paths are allowed even when absent. Each task owns its listed source files, own regression test and own report only. Task 01 owns all shared UI (including ReviewSteps), Shell/AppWindow/topbar/dock/phone. Task 02 owns home map + Today. Feature-specific settings are split: Front Desk/Profile=03; Prices/Estimate/Financing/Tiers=04; Schedule/WorkHours/CalendarConnection=06; AgentsTab/AgentRules and job ClaimSection=07; StormTab/AdConnections=08; settings container/company/team/connections=09. Task 09 must not edit imported feature settings owned elsewhere. Every copy file has one owner. Request changes in another owner's file via handoff; do not edit it.

Branch `codex/ironclad-full-ui-NN` from `codex/ironclad-full-rebuild`. Commit and push task branch only; no merge, force-push, main/integration push. Do not edit shared ledgers/briefs/manifest/reference assets. Own report must include branch/SHA, files, preserved workflows, before/after reference evidence, commands/results, screenshots actually obtained, gaps, cross-owner requests and CI URL/status. Do not weaken assertions to conceal lost functionality. Existing tests may be run by anyone; only Task 01 may update its explicitly listed existing token test. Other required existing-test adaptations go to controller.

Task 01 publishes existing-token/API compatibility and geometry decisions early; preserve public component APIs so tasks can proceed concurrently. Router/export changes wait for controller. Controller waits for all ten outputs and task CI before integrating, then repeats whole-product checks and reference screenshots. No session independently declares final fidelity or functional completion.

## Verification and CI

Use smallest relevant existing tests plus own meaningful regression checks; run `npm run typecheck`, `npm run lint`, `npm run lint:css`, `npm run build:web` before handoff where supported. Focused web checks: `npx vitest run --project @roofline/web apps/web/test/<file>`; UI equivalent uses `@roofline/ui`. Docker-less sessions must not run database-backed suites; report and rely on GitHub CI. Playwright inventory: `npx playwright test --list -c apps/web/playwright.config.ts`.

Current CI has five required areas: Platform (lint/typecheck/full tests), E2E (desktop+phone and separate demo walkthrough), v1, Demo DB (arm64), Hail service. Preserve all; report full CI rather than the legacy watcher that checks only Platform. Integrated verification includes build, full web/UI suites, desktop/phone scenarios and demo walkthrough using `apps/web/playwright.demo.config.ts`. Docs-only pushes skip CI: a report is not a successful run. Do not execute real-provider manual smoke scripts. Record pending/unavailable checks honestly.
