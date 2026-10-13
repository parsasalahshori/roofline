# Faithful Ironclad frontend rebuild

Source baseline: `0fa8126` from `f2-shell-wbg3ja`. Integration branch: `codex/ironclad-f2-rebuild`.
Live visual authority: https://roofing-os-demo.vercel.app/ . The objective is faithful reproduction of the observed reference, not an invented redesign.

## Instructions shared by every task

Use **GPT-6 Astra only**, including any expressly authorized child work. This user instruction overrides legacy Claude/Haiku/Sonnet/Opus model rulings. Do not substitute a model. Read `AGENTS.md`, `ops/README.md`, `ops/sdd/f2/global-constraints.md` and the relevant F2 ledger/briefs. Existing security and business rules remain binding. The user's faithful-Ironclad request overrides prior hard-coded visual tokens and window sizing only; it does not waive accessibility, copy, tenant isolation, permissions or approval semantics.

The actual checkout contains F2. Later-milestone completion claims in documentation do not establish available source features. Jobs, customers, calendar, estimator, front desk and agents routes are placeholders; settings connections/billing/setup are placeholders; Today appointments are unconditionally empty. Storm has a pending-plan entry, not the full S1 product. Preserve all existing actions and routes. Do not fake new live features, statistics, successful mutations or backend availability.

Do not edit backend, worker, database, send-gate, shared business types, environment files, dependencies or lockfile. Preserve `apps/web/src/api/**`, feature `api.ts` hooks, session/query providers, routing, RBAC, owner-only settings, company-switch cache clearing, versioned approvals, optimistic rollback, retry/rerun/decline and demo/live safeguards. New endpoints are out of scope. Keep CSS Modules, centralized copy, shared buttons, strict ESM TypeScript, keyboard/focus behavior, minimum 12px text and phone touch targets. No real sends, paid providers, credentials or accounts.

Controller handles screenshot/reference extraction and will supply captured assets when available. If a cloud session lacks browsing or reference assets, report that evidence gap and implement only supported observations; never claim visual QA happened. Do not invent reference measurements. Preserve map's no-network test mode.

Each task branches from `codex/ironclad-f2-rebuild` using its exact branch below, commits owned changes, runs targeted checks and pushes **only its task branch**. Never merge, force-push or push to main/integration. No app file outside the explicit ownership list. Communicate a cross-boundary requirement in the report instead of editing another task's files. No opportunistic refactors or dependency updates; a clean cloud checkout may run `npm ci` without changing manifests or the lockfile.

Each task owns only its own new `ops/ironclad-rebuild/task-NN-report.md` report in this folder. Report commit SHA/branch, changed files, preserved actions, reference evidence used, checks with actual results, screenshots produced, unresolved evidence gaps and integration requests. Do not edit this README or other briefs/reports. Report unavailable checks honestly.

## Ownership and integration

| Task | Branch | Owner area |
|---|---|---|
| 01 | codex/ironclad-ui-01 | Tokens and small primitives |
| 02 | codex/ironclad-ui-02 | Window/sheet/card geometry |
| 03 | codex/ironclad-ui-03 | Map/home and storm presentation |
| 04 | codex/ironclad-ui-04 | Top bar/search/account |
| 05 | codex/ironclad-ui-05 | Shell/dock/phone navigation |
| 06 | codex/ironclad-ui-06 | Today |
| 07 | codex/ironclad-ui-07 | Approval/review |
| 08 | codex/ironclad-ui-08 | Settings |
| 09 | codex/ironclad-ui-09 | Auth/coming-soon/error surfaces |
| 10 | codex/ironclad-ui-10 | Read-only contracts audit and new regression tests |

Task 05 exclusively owns `Shell.tsx`/`Shell.module.css`; Task 02 exclusively owns `AppWindow.tsx` and Window/Sheet/Card/StatCard/EmptyState. Task 01 must not edit these or Dock/TopBar/ReviewSteps. Router, shared hooks/types and package exports remain frozen; controller owns any necessary integration-only changes after all reports. New exports should normally be unnecessary because public component APIs are preserved.

Workers may run concurrently against the baseline with existing token names/component APIs. Task 01 reports token changes early; Tasks 02/05 agree required insets via reports/messages, not shared edits. Controller waits for **all ten outputs and CI** before integration; recommended order 01, 02, 04, 05, 03, 06–09, 10. Controller resolves integration issues, runs typecheck/lint/CSS lint/build plus relevant web/UI and desktop/mobile regression suites, and compares integrated screenshots with the exact live reference. No task may declare the integrated product complete independently.
