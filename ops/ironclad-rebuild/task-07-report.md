# Task 07 — Agents, claims and agent settings

Branch: `codex/ironclad-full-ui-07`.
Implementation SHA: `05ff553a356c1be13d2ca128cab7226616dd2f2d` (includes `ad4202d6` and `7730e731`; no history rewritten).
Base: exact preparation SHA `81b9251490cfa05eac4baecc68f6952b549a1460`, verified descendant of complete-app `ff772d5cbf87eac051759e9049fb29930845a45f`.

The assigned presentation changes are implemented and pushed. Full-product integration and final exact visual fidelity remain controller work; this report does not assert whole-product readiness.

## Source and boundaries

The initial unprivileged fetch failed at proxy port 8080. On resume, supported per-command network permission recovered fetch, npm, Docker and push without changing proxy variables, network policy, browser security, credentials or dependencies. The old `work` checkout at `46c6e1f` had clean tracked files and was not edited. Fetched an explicit remote ref, verified the preparation SHA and ancestry, and created the task branch. No other sessions or subagents were started.

Only ownership key 07 source files, the new regression test and this report changed. API hooks, feature types, business helpers, backend, providers, database, workers, send gates, router, shared exports, dependencies and lockfile remain unchanged. No real-provider calls, real messages, spend, production changes, merges or main/integration pushes.

## Result and preserved workflows

- Agents overview: compact real-data summary cards, roof-shaped agent selectors, colored agent identities, per-agent status and metrics, and a responsive inspector with working detail/review/settings links. Phone selection places the inspector before the full card list. Counts use the role-scoped overview response; no reference figures are copied.
- Detail/feed/waiting: compact neutral surfaces, readable rules, time breakdowns and task lists, reachable filters and controls. Existing links, period queries, stale-data warnings, retries and pagination remain.
- Claims: searchable, status-filtered grouped rows retain all nine statuses and direct job links. An optional inspector loads the existing ClaimSection for the chosen job. Successful saves refresh the board via its existing query. Keyboard focus enters the inspector; filtering never makes a mutation.
- Job claim: clearer status, fact grid, history, edit and packet controls; an explicit explanation that building the packet sends nothing to an insurer or adjuster. All claim form parsing, changed-field PUT semantics, intake clearing, field errors, packet readiness and download URL remain.
- Settings: agent rules appear first in distinct groups, with jumps to rules and time estimates that scroll only the window body and keep the title/close control visible. All rule fields, validation, owner gates, baseline inputs/default resets, office read-only state and owner-only dry-run/confirm recount remain.
- Pause confirmation, G1 turn-on rules sheet, default-paused state, run cooldown, owner/office/rep visibility, null-rate money hiding, approval navigation, pending locks and backend billing restrictions are unchanged. Every saved-time/money estimate still uses the original snapshot helpers and estimate qualifiers. Scheduler/Follow-up drafts and spacing/stop rules are untouched.

## Reference and actual visual evidence

Inspected committed `reference/agents-1440x900.jpg`, `claims-1440x900.jpg`, and `front-desk-phone-390x844.jpg`, plus both computed-style JSON captures and reference README. No live reference provider action was attempted.

Before: the source used generic agent cards, a wrapping claim-column board, and a long estimates-first settings page. After: the scoped UI adopts the reference's roof silhouette, white rounded surfaces, graphite text, app colors, compact controls and claim list/detail arrangement. There is no fabricated handoff animation, staffing equivalent, replacement-cost/recovery figure or insurer action. Existing actual 14-day task charts are retained; reference hourly data is unavailable.

Captured and inspected real local-stack renders using isolated synthetic fixtures, PostGIS/API/worker and fake providers, at 1440×900 and 390×844. Screenshots are in `/workspace/work/task07/screenshots/` in this session, intentionally not committed outside the exclusive allowlist:

- `agents-{1440x900,390x844}.png`
- `claims-{1440x900,390x844}.png`
- `claim-inspector-{1440x900,390x844}.png`
- `job-claim-{1440x900,390x844}.png`
- `settings-{1440x900,390x844}.png`
- `time-baselines-{1440x900,390x844}.png`

`/workspace/work/task07/visual-checks.json` records no document overflow on overview, claims and settings at both sizes. The capture script also asserts that settings section jumps keep the Settings title on screen. No screenshot was edited to conceal the inherited shell.

## Checks actually run

| Check | Result |
| --- | --- |
| `npm ci --cache /workspace/work/task07/npm-cache` | Passed; default cache path was unwritable on the first attempt. Dependency/lockfile unchanged. |
| `npm ls playwright-core` | Only 1.56.1, deduplicated. Node v24.19.0 satisfies the project engine. |
| Ten baseline scoped web files | 108 tests passed before edits. |
| Scoped final web suite: agents-*; agent-page; agent-rules; claims-board; claim-section; g1-turn-on; time-baselines*; ironclad-full-07 | 16 files, 143 tests passed. |
| Own new regression file | 4 tests: rep-safe inspection, search/status clearing with job links, real inline changed-field save + row refresh, failed-load retry. |
| Scoped API suite with Testcontainers PostGIS | 8 files, 144 tests passed: agents-api, agents-settings, agents-recount, agents-run-now, agents-feed-routes, agent-values, claims, no-insurer-contact. |
| Existing desktop E2E: agents, agents-settings, more-agents | 16 passed against real isolated stack/fake providers, including pause, run cooldown, review navigation, turn-on, baseline/recount, claim save/packet and approved weather moves. |
| Existing targeted accessibility and phone E2E | 9 passed: 7 desktop axe checks and 2 phone agent checks. Used the same isolated stack via a temporary work-only config; repository configs unchanged. |
| `npm run typecheck` | Passed after final UI fix. |
| `npm run lint` | Passed after final UI fix. |
| `npm run lint:css` | Passed; 12px floor preserved. |
| `npm run build:web` | Passed; existing large-bundle warning remains (about 2.15MB uncompressed main JS). |
| `git diff --check` and ownership comparison | Passed. |
| Desktop/phone visual capture | 12 actual screenshots; real fixture endpoints, no production data. |

Logs, temporary scripts and screenshots live in `/workspace/work/task07/`. The first E2E invocation misplaced filenames after Playwright's variadic `--project`; corrected invocation was `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run e2e -- agents.spec.ts agents-settings.spec.ts more-agents.spec.ts --project=desktop`. It ran all 16 tests. Docker was checked through the managed local socket with supported command permissions. No unavailable check is counted as passing.

## CI

Latest implementation run: [CI 38335051235](https://github.com/parsasalahshori/roofline/actions/runs/38335051235), verified for `05ff553a356c1be13d2ca128cab7226616dd2f2d` from the GitHub web run title. At October 12, 2026, 7:05 PM PDT, **all five jobs were queued**: Platform; E2E (Playwright); v1; Demo DB (arm64); Hail service. No CI success is claimed. The report-only follow-up commit changes no runtime/test code and is excluded by the workflow's paths-ignore rule.

`gh run list` returned `Forbidden` for `api.github.com`; the permitted `github.com` web page supplied the real run URL and job statuses instead. Neither policy nor credentials were changed. `/workspace/work/task07/ci-status.json` records the observed status. Earlier runs [38334741072](https://github.com/parsasalahshori/roofline/actions/runs/38334741072) and [38334882361](https://github.com/parsasalahshori/roofline/actions/runs/38334882361) belong to superseded task commits and are not the final gate.

## Controller / cross-owner handoff and remaining gaps

1. Task 01/controller: integrate shared Window/AppWindow/header/dock/font/tokens, then recapture. This branch's inherited desktop window measures x80/y65, 1280×741 at 1440×900; reference window is x20/y42, 1400×766. Phone inherits a full-width window at y57. The shared beige canvas, system font, title sizing, unstyled map and old dock remain visible in the evidence and are not within key 07. These prevent a claim of final exact fidelity.
2. Controller routing/export ownership: Claims remains available through `/agents/claims` and job claim sections. If a standalone Claims dock/window matching the reference is wanted, route/app registration belongs to the controller. No route/export changes were made here.
3. Reference-only staffing, handoff, RCV/depreciation and AI recovery figures have no corresponding allowed contract. The UI shows actual available data instead. No money logic was invented. The reference instruction editor/permission toggles are not substituted for Roofline's real rule/approval model.
4. Final combined branch needs the five-area GitHub CI gate and integrated desktop/phone/demo walkthrough. This task ran scoped API/browser checks, not the full local product suite, ARM64 demo, v1 or hail service. Live-provider manual smoke was not performed.
5. Task 09: agent settings content now puts rules before time estimates, retaining every field and recount workflow; its surrounding Settings navigation stays owned by 09. No cross-owner edit is required for the current branch to typecheck.

## Files

- `apps/web/src/copy/agents.ts`
- `apps/web/src/copy/claims.ts`
- `apps/web/src/features/agents/ActivityFeed.module.css`
- `apps/web/src/features/agents/AgentCard.module.css`
- `apps/web/src/features/agents/AgentCard.tsx`
- `apps/web/src/features/agents/AgentControls.module.css`
- `apps/web/src/features/agents/AgentLists.module.css`
- `apps/web/src/features/agents/AgentPage.module.css`
- `apps/web/src/features/agents/AgentPage.tsx`
- `apps/web/src/features/agents/AgentsTabs.module.css`
- `apps/web/src/features/agents/AgentsWindow.module.css`
- `apps/web/src/features/agents/AgentsWindow.tsx`
- `apps/web/src/features/agents/ClaimsBoard.module.css`
- `apps/web/src/features/agents/ClaimsBoard.tsx`
- `apps/web/src/features/agents/MiniChart.module.css`
- `apps/web/src/features/agents/RecountSection.module.css`
- `apps/web/src/features/agents/RulesList.module.css`
- `apps/web/src/features/agents/TimeBaselines.module.css`
- `apps/web/src/features/agents/WaitingList.module.css`
- `apps/web/src/features/job/ClaimSection.module.css`
- `apps/web/src/features/job/ClaimSection.tsx`
- `apps/web/src/features/settings/AgentRules.module.css`
- `apps/web/src/features/settings/AgentsTab.tsx`
- `apps/web/test/ironclad-full-07.test.tsx`
- `ops/ironclad-rebuild/task-07-report.md`
