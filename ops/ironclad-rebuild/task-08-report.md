# Task 08 — Approvals, storm response and door routes

## Branch and source

- Branch: `codex/ironclad-full-ui-08`.
- Implementation commit: `06c7521d94edaa0c559d73d2a0ccf4ebc1d112fa` (pushed).
- Preparation source verified exactly: `81b9251490cfa05eac4baecc68f6952b549a1460`.
- Verified ancestor: complete application `ff772d5cbf87eac051759e9049fb29930845a45f`.
- The original clean checkout was `46c6e1f6985f47fe9698cb4b24a9f454bfb21877`. No work was done against it. Fetch succeeded with the cloud runtime's per-command network permission and explicit remote-tracking refspec; proxy variables and network policy were preserved.
- No merge, main/integration push, force-push, dependency/lockfile/config change, or extra agent/session. Only key `08` source paths, its new regression test and this report changed.

Task implementation is complete. Full CI and integrated visual acceptance remain separate gates; this report does **not** declare whole-product readiness.

## What changed

| Area | Result |
| --- | --- |
| Storm detail | A large hail map beside a 344px response column on desktop; compact real impact counts, radar-estimated hail badge, explicit plan status, draft-versus-progress guidance, and visible routes/back navigation. Phone shows storm identity and counts before the map. |
| Storm list | Compact neutral event cards, an amber response card, clearer dates/counts/status, and a real retry action on the existing query. The existing two-click approval entry point remains. |
| Approvals | Clear review links, compact agent/status/drafted strip, return navigation, and numbered accessible preview sections. Shared `ReviewSteps` remains untouched. |
| Step previews/sheets | Readable message samples, warnings, spending maximums, route assignments and edit forms with neutral surfaces, restrained type, wrapping and phone spacing. No kit serializers, validation or payload builders changed. |
| Door routes | Desktop map/current-door columns; phone puts the address, navigation and all five 48px outcome targets before the map. Server-reported progress, `aria-current="step"`, and each saved outcome make it clear where work stands. |
| Storm settings/ad accounts | Compact threshold/email/budget layout, readable templates, neutral connection cards and distinct connection states. All existing controls remain. |

All 36 implementation files appear in `git diff --name-only 81b9251490cfa05eac4baecc68f6952b549a1460 06c7521d94edaa0c559d73d2a0ccf4ebc1d112fa`. They comprise four owned copy files; approval list/review/sheet/preview presentation; storm list/detail/results/map styles; route list/detail/outcome/lead-sheet presentation; StormTab and AdConnections presentation; and `apps/web/test/ironclad-full-08.test.tsx`. An automated comparison against ownership key `08` found no outside paths.

## Preserved contracts and workflows

- All backend, worker, provider, database, HTTP hooks/types, approval helpers/registry and route/navigation/validation helpers are unchanged.
- Approval `{steps: [{id, version}]}`, `canApprove`, class visibility, pending edit locks, optimistic rollback, 409 reconciliation, decline, retry, expiry, rerun and polling are unchanged. Existing review tests and stack approval scenarios pass.
- Storm draft/open/dismiss/re-draft conditions and their API errors are unchanged. A draft is described as preparation, not delivery or ad execution. Running plans show progress guidance rather than another approval promise.
- Every real results field remains, including opt-outs, delivered texts, replies, door outcomes, booked inspections and actual/capped ad spend. No opportunity, damage or revenue values from the reference were fabricated.
- All five door outcomes still use `useRecordOutcome`; wants-check still uses the original validation, explicit unchecked texting consent, field errors and lead mutation. No owner names were added to noncustomer stops.
- Role restrictions, tenant isolation, billing refusals, fake/live separation, send/spend gates and public consent/signing are unchanged. Tests use the repository's local fake providers only.

## Reference and screenshot evidence

Inspected committed `reference/storm-1440x900.jpg`, `desktop-1440x900.jpg`, and `front-desk-phone-390x844.jpg`; read reference README and computed desktop/Front Desk styles. The storm reference's dominant map, narrow response column, small metric cards, amber response action, cool neutral surfaces and compact typography guide this implementation. The 344px column is an implementation choice informed by the image, not a claimed DOM measurement of the live Storm view.

Before/after captures were made with Chromium against the local Docker/PostGIS/API/worker fake-provider stack. The before assets were built from a separate `git archive` of the exact preparation commit; after assets came from this task's build. The same API fixture data served both. No browser request fabricated counts. Opening the wants-check sheet did not save a lead during visual capture; route construction used the local fake-provider approval flow.

- Evidence archive: `/workspace/work/task08/task08-visual-evidence.tar.gz` (36 PNGs plus final metrics; 2.1MB).
- Evidence directory: `/workspace/work/task08/screens/` (local artifacts; not committed because the exclusive allowlist has no screenshot path).
- 36 PNGs: `before-` and `after-`, each at **1440×900** and **390×844**, for `storm-list`, `storm-detail`, `approvals`, `review`, `storm-settings`, `ad-connections`, `routes`, `route-detail`, `lead-sheet`.
- Representative comparisons: `before-storm-detail-1440x900.png` / `after-storm-detail-1440x900.png`; `before-review-390x844.png` / `after-review-390x844.png`; `before-route-detail-390x844.png` / `after-route-detail-390x844.png`.
- `metrics.json` records the final 16 main-screen captures (the lead-sheet captures are additional screenshots). Page widths equal 1440 or 390 as appropriate; no visible-overflow descendants were detected in the inspected feature dialogs.
- Visually inspected the actual before/after storm list/detail, approval list/review, settings/ad connections, route and lead-sheet captures, including the final phone action layout. The final phone route shows all five outcome buttons before the map.
- These captures retain the baseline shared shell/UI and its font. The test map deliberately has no live street tiles and uses synthetic seeded contours/addresses. They prove feature layout under the test stack, not exact integrated Ironclad fidelity or production map/provider readiness.

## Checks

Environment: Node `v24.19.0`; Docker `28.4.0`; system Chromium selected through the repository-supported `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium`. Networked Git/npm/Docker/E2E commands used the supported per-command permission; no proxy/policy/Chrome configuration was changed.

| Check | Actual result |
| --- | --- |
| `npm ci --cache /workspace/work/npm-cache` | Passed, 858 packages; dependency files unchanged. Initial default-cache attempt failed because `/home/agent/.npm/_cacache` was unwritable. |
| `npm ls playwright-core` | Only `1.56.1`. |
| Baseline scoped web suites | 12 files, **156 passed**, before edits. |
| New regression test, before implementation | Four assertions failed as expected for absent plan status/routes, retry action and current-door semantics. |
| Final expanded scoped web suites | 24 files, **260 passed**. |
| Last plan-guidance copy check | `ironclad-full-08.test.tsx` + `storm-detail.test.tsx`: **19 passed**. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm run lint:css` | Passed, including the 12px floor. |
| `npm run build:web` | Passed; existing large-chunk warning remains (main JS approximately 2.14MB uncompressed). |
| Focused Docker-backed API tests | 8 files, **223 passed**. |
| Full requested scoped E2E attempt | **7 passed, 1 environment-blocked failure**. Public landing-page test received `Domain forbidden` for `acme-roofing.roofline.test:4410` before its form appeared. |
| Final seven applicable E2E scenarios | **7 passed** on the final implementation (1.2 minutes). |
| `git diff --check` and ownership comparison | Passed; no frozen/outside files changed. |

Final web command: `npx vitest run --project @roofline/web` with `apps/web/test/` files `ironclad-full-08.test.tsx`, `review.test.tsx`, `approval-sheets.test.tsx`, `approvals-list.test.tsx`, `step-fields-sheet.test.tsx`, `step-ads.test.tsx`, `step-texts.test.tsx`, `step-visits.test.tsx`, `step-routes.test.tsx`, `step-email.test.tsx`, `step-moves.test.tsx`, `storm-detail.test.tsx`, `storm-results.test.tsx`, `storm-window.test.tsx`, `storm-list.test.tsx`, `door-outcome.test.tsx`, `route-view.test.tsx`, `my-routes.test.tsx`, `settings-storm.test.tsx`, `settings-ads.test.tsx`, `step-g1-registry.test.tsx`, `step-wiring.test.ts`, `review-copy.test.ts`, `s1-routes.test.tsx`.

API command: `npx vitest run --project @roofline/api` with `apps/api/test/` files `approvals-approve.test.ts`, `approvals-edit.test.ts`, `doors.test.ts`, `storm-routes.test.ts`, `storm-routes-paused.test.ts`, `storm-rerun.test.ts`, `storm-pause.test.ts`, `storm-requests.test.ts`.

E2E command: `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm_config_cache=/workspace/work/npm-cache npm run e2e -- approvals.spec.ts storm.spec.ts doors.spec.ts`. Final focused rerun adds `--grep-invert 'landing page on a phone submits a request'` to explicitly exclude the already-observed blocked hostname test; this is not a claim that the full eight passed. A first final rerun was blocked by the still-running visual stack on port 4410; that owned test process was stopped and the command retried.

Logs are under `/workspace/work/task08/`: `baseline.log`, `scoped-final.log`, `last-copy-check.log`, `typecheck-final.log`, `lint-final.log`, `css-final.log`, `build-final.log`, `api.log`, `e2e.log`, `e2e-final.log`, `capture-current.log`.

## Real CI

Implementation CI: [run 38334538045](https://github.com/parsasalahshori/roofline/actions/runs/38334538045), triggered by `06c7521d94edaa0c559d73d2a0ccf4ebc1d112fa` on this task branch. The report-only follow-up commit is intentionally not evidence of a new test run.

At the latest observed run-page check:

| Required area | Status |
| --- | --- |
| Platform (lint, typecheck, tests) | Queued |
| E2E (Playwright) | Running |
| v1 (node:test) | Queued |
| Demo DB (arm64) | Passed |
| Hail service (ruff, pytest) | Passed |

`gh run list` could not reach `api.github.com` (`Forbidden`). The public `github.com` run page is reachable through the unchanged supported proxy and provides the real run/job statuses above. No CI success is inferred from local tests.

## Remaining gaps and controller requests

1. Wait for all five CI areas before integration. Full-product suites, the separate demo walkthrough, Hail and ARM64 checks were not run locally; CI is the remaining gate for those areas.
2. Recheck the public storm request E2E in real GitHub CI. The local failure page was `Domain forbidden`, not an application form error. No hostname/proxy workaround was introduced. The focused public-request API regression passed.
3. Task 01/controller: integrate the shared Ironclad shell dimensions, Archivo/font decision, tokens, controls, dock and `ReviewSteps` styling. This task did not edit them. Re-capture these features after integration; do not judge the isolated baseline shell as final visual fidelity.
4. Map owner/controller: validate real map tiles and combined hail layers at desktop/phone after integration. Real geometry/legend helpers were preserved; no synthetic reference background or unsupported revenue/damage metrics were added.
5. Reference evidence has no dedicated approval, door-route or storm-settings phone capture. Those screens follow the measured common visual system and retain the full app's workflows; exact independent pixel matching for them is not claimed.
6. No router/export/API changes are requested. No existing tests were edited or weakened. No real-provider smoke, messages, ad spend, customer data or production changes were performed.
