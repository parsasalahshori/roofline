# Task 10 — backend contract preservation and regression QA

Branch: `codex/ironclad-full-ui-10`. Exact preparation baseline: `81b9251490cfa05eac4baecc68f6952b549a1460`; verified ancestor: `ff772d5cbf87eac051759e9049fb29930845a45f`. Implementation/test SHA: `280a105d90c248ab3ba1fc60e9183fc733267d7d`, pushed to the task branch. Subsequent evidence/report commits change only this report and new QA artifacts; the tested production/test tree is unchanged.

## Result and integration blocker

QA-only scope: no production, backend, provider, worker, database, send-gate, HTTP hook, business helper, dependency, lockfile, router or shared-export edits. Added 11 hook/UI regressions and seven real-stack Playwright scenarios, with explicit 1440×900 and 390×844 groups. The new tests intentionally retain a reproducible baseline failure; this branch is **not green and must not be treated as whole-product readiness**.

**T10-01 — company-switch query reset races React detail unmount (controller fix required).** In `apps/web/src/api/hooks.ts`, `useSwitchCompany` awaits navigation, then resets all non-account queries. Both the real Chromium browser (desktop and phone reference sizes) and the hook/router test observe another GET for the old approval ID after the company-switch response. Awaiting navigation did not ensure that the old query observer had unmounted. The unit reproduction uses a realistic 404 after the switch and still verifies cache clearing and the new account. Browser checks verify the old plan disappears, the switched account is correct, direct access returns 404, and the old URL cannot render approval controls. No cross-company data disclosure was observed. Keep the no-old-ID-refetch assertion; review navigation commit/unmount ordering in a separately authorized controller fix. Task 10 cannot edit frozen hooks.

## Deliverables

- `apps/web/test/ironclad-full-10.test.tsx`: company-switch detail/cache ordering; overlapping optimistic edit rollback; pending-edit approval lock and 409 latest-version reconciliation including disabled and owner-only steps; public sign 401/409/410 cookie-free behavior and encoded token; blocked reply versus team handoff and selective invalidation; all four demo simulation mutation/error contracts.
- `apps/web/e2e/ironclad-full-regression.spec.ts`: real canceled-company read-only/billing recovery/Front Desk OFF persistence, blocked re-enable/transfer/customer writes; office stale-tab conflict and owner-only spend; company switching and server isolation; non-demo UI/probe and four absent simulation routes. Uses existing fake providers and disposable test DB helpers. No intercepted backend responses.
- `ops/ironclad-rebuild/qa/task-10/contract-inventory.json`: actual router paths and 39 frozen HTTP module signatures, request patterns and SHA-256 digests; tracked frozen-scope counts and no changed frozen paths.
- `ops/ironclad-rebuild/qa/task-10/coverage-map.md`: route/action/role/demo preservation inventory, existing coverage, integration requests and bounded Task 01 source audit.
- 27 baseline runtime screenshots, screenshot SHA-256/dimension manifest, compact check output, E2E results, environment-block evidence and actual CI snapshot under `qa/task-10/`.

## Final local checks

| Check | Result |
| --- | --- |
| Bootstrap | Initial ordinary fetch hit proxy refusal; supported per-command network permission succeeded, without changing proxy/policy. Exact preparation SHA and complete-app ancestry verified; clean original checkout preserved. |
| Install | `npm ci --cache /workspace/.cache/npm` passed (858 packages). First attempt failed writing default `/home/agent/.npm`; workspace cache retry fixed the environment issue. No dependency file changes. |
| Node / Playwright | Node v24.19.0 satisfies >=22.13; `npm ls playwright-core` resolves only 1.56.1. Local stack browser is `/usr/bin/chromium`; CI installs pinned Playwright Chromium. |
| Baseline focused web | 49 passed: company-switch, review, homeowner, Front Desk invalidation, demo badge. |
| Baseline web/UI/shared/send-gate | 201 files, 3,482 tests passed; explicit exclusion of the new task-10 test separates existing baseline from new finding. |
| Scoped real API/DB | Eight suites, 250 passed: read-only, read-only-guard, rep-visibility, approvals edit/approve, proposal signing, demo routes, Front Desk settings. Docker v28.4.0 reachable with supported per-command permission. |
| New hook/UI regressions | 10 passed, 1 failed: T10-01 above. No skip, expected-failure marker or weakened assertion. |
| Typecheck / lint / CSS lint / web build | Passed. Typecheck/lint repeated after final test edits. Existing Vite large-chunk warning remains. |
| Playwright discovery | Passed, including the new seven cases. Discovery is not counted as execution. |
| New stack regressions | **5 passed, 2 failed**: the two reference-sized company-switch cases reproduce T10-01. All other new cases pass. |
| Existing E2E subset | **38 passed, 1 environment-blocked**: CRM, calendar, estimator, homeowner, Front Desk, storm and phone files. The public company-host page displays `Domain forbidden`; details below. |
| Combined final E2E invocation | **43 passed, 3 failed**, 46 cases, 4.0 minutes, after a fresh ordinary web build. |
| Separate demo walkthrough | **1 passed**, 3.3 minutes including startup; all text/call/storm/sign simulations plus real signed PDF content/readiness check, isolated compose project `roofline-demo-smoke`, app 4510 / DB 54349. |

## Visual and change-audit limits

Inspected all ten committed reference JPEGs and both measured-style JSON files. Reference desktop is 1440×900 and phone is 390×844. Baseline runtime screenshots are not an integrated redesign comparison. The ordinary E2E map deliberately avoids remote tiles. The separate demo build enables OpenStreetMap; its captured home shows a map-loading warning and no basemap. No exact map visual-fidelity pass is claimed. No reference synthetic metrics were copied into application data.

Read-only audited Task 01 `ef55d423fd2356cdde41e7e20ee1c3e06d92bf68` (35 files). TSX changes retain existing hrefs, role labels, badge semantics, close/navigation/focus wiring; the new Window titleIcon is optional and decorative. No frozen-contract drift in that diff. Other UI task branches were not published at inspection; none were merged here. Controller must repeat the workflow and screenshot checks on the assembled redesign.

Controller also owns adaptation of the old 1280px shell geometry assertion and any desired phone-project discovery changes. Preserve behavioral assertions when adapting visuals. Full local `npm test`, all E2E files, local v1, ARM64 and Hail were not run by this task; real CI status must be checked for all five areas, not inferred from baseline tests or documentation-only commits.

## Final evidence and CI

CI run for implementation SHA: https://github.com/parsasalahshori/roofline/actions/runs/38334312930 (push-triggered run 992). Actual observation is saved in `qa/task-10/ci-status.json`; no job conclusion was available at that snapshot. Documentation/artifact-only follow-up pushes do not create a new CI run.

| Required CI area | Observed status | Actual job |
| --- | --- | --- |
| Platform (lint, typecheck, tests) | In progress | https://github.com/parsasalahshori/roofline/actions/runs/38334312930/job/115090859625 |
| E2E (desktop/phone, then demo) | In progress | https://github.com/parsasalahshori/roofline/actions/runs/38334312930/job/115090859878 |
| Demo DB (arm64) | Success | https://github.com/parsasalahshori/roofline/actions/runs/38334312930/job/115090859777 |
| v1 (node:test) | Queued | https://github.com/parsasalahshori/roofline/actions/runs/38334312930/job/115090859927 |
| Hail service (ruff, pytest) | Queued | https://github.com/parsasalahshori/roofline/actions/runs/38334312930/job/115090859960 |

These are pending checks, not successes. The retained company-switch assertions are expected to block a green Platform/E2E result until the controller resolves T10-01. If ordinary E2E fails, the later demo step in that CI job will not execute; the successful **local** isolated demo run is separate evidence.

### Executed commands and evidence

All network/Docker commands used the supported per-command network permission, preserving inherited proxy and restricted policy. Default shell execution alone could not access the proxy. No Chrome flags, environment-policy files, credentials, dependencies or frozen production files were changed.

```sh
npm ci --cache /workspace/.cache/npm
npm ls playwright-core
npm run typecheck
npm run lint
npm run lint:css
npm run build:web
npx vitest run --project @roofline/web apps/web/test/company-switch.test.tsx apps/web/test/review.test.tsx apps/web/test/homeowner.test.tsx apps/web/test/d1-t26-invalidate.test.tsx apps/web/test/demo-badge.test.tsx
npx vitest run --project @roofline/web --project @roofline/ui --project @roofline/shared --project @roofline/send-gate --exclude '**/ironclad-full-10.test.tsx'
npx vitest run --project @roofline/web apps/web/test/ironclad-full-10.test.tsx
npx vitest run --project @roofline/api apps/api/test/read-only.test.ts apps/api/test/read-only-guard.test.ts apps/api/test/rep-visibility.test.ts apps/api/test/approvals-approve.test.ts apps/api/test/approvals-edit.test.ts apps/api/test/proposal-sign.test.ts apps/api/test/demo-routes.test.ts apps/api/test/front-desk/settings-routes.test.ts
npx playwright test --list -c apps/web/playwright.config.ts
PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c apps/web/playwright.config.ts ironclad-full-regression crm.spec calendar.spec estimator.spec homeowner.spec front-desk.spec storm.spec phone.spec --project desktop --project phone
# Separately, from apps/web:
PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c playwright.demo.config.ts
```

Screenshot runs additionally set `IRONCLAD_QA_SHOTS` or the existing demo suite's `DEMO_SHOTS` to the task-10 QA directories. Local browser: Chromium 154.0.8037.57; Playwright package/core: pinned 1.56.1. CI installs that Playwright version's browser, so pending CI still matters.

- `qa/task-10/check-results.txt`: focused/broad baseline counts, API results, type/lint/CSS/build, retained unit failure and demo result.
- `qa/task-10/e2e-results.txt`: final serial ordinary-stack test results and three failures, with worker/provider chatter omitted.
- `qa/task-10/public-storm-environment-block.txt`: precise existing phone-test blocker.
- `qa/task-10/screenshot-manifest.json`: all 27 PNG paths, dimensions, sizes, hashes and capture origins.
- `qa/task-10/screenshots/{canceled-billing,office-approval,company-isolation}-{1440,390}.png`: six real-stack states at reference sizes. These verify recovery/role/conflict/isolation presentation, not final redesign fidelity.
- `qa/task-10/demo-screenshots/01-.png`, `06-front-desk.png`, `03-jobs.png`, `04-estimator.png`, `07-calendar.png`, `05-storm.png`, `08-agents.png`, `10-agents-claims.png`: baseline counterpart captures for the supplied reference views. Other numbered demo captures preserve the tour/simulation sequence. Demo screenshots are 1440×900. New 390px tests use a phone-sized viewport in the desktop project; existing phone tests separately use Pixel 7 emulation.

### Remaining gaps and cross-owner requests

1. **T10-01, reproducible baseline defect:** coordinate a separately reviewed correction at the frozen hook/navigation boundary. Task 10 leaves all three failing assertions intact. No skip/expected-failure marker or production workaround.
2. **T10-ENV-01, public storm host blocked locally:** existing `phone.spec.ts` “S1 pages do not scroll sideways” reaches `http://acme-roofing.roofline.test:4410/storm/<synthetic-code>` and displays **Domain forbidden**. It cannot find “Request a free inspection.” This is not an assertion of successful public consent coverage. No policy/DNS/proxy/browser bypass attempted; use real CI to resolve the coverage gap.
3. **Demo map evidence gap:** captured map-loading warning and missing basemap; diagnosis/fidelity requires the controller's supported browser environment. Ordinary fake-stack map behavior and demo tile behavior are distinct.
4. **Unassembled UI:** only Task 01's published source diff was audited; Tasks 02–09 and integrated visual/function behavior remain controller work. Rerun every relevant workflow after integration. Adapt deliberate geometry expectations without weakening roles, focus, approval or data checks.
5. **Pending CI:** all five actual jobs must complete; local v1/Hail/ARM64 and full DB/worker suites were not run. No whole-product readiness declaration.

### Verification provenance

An initial canceled-company fixture omitted required Front Desk settings and got 400; the fixture was corrected to use the existing full contract. An initial ordinary E2E subset was interrupted (exit 130) after discovering that the concurrently started demo rebuilt the shared `apps/web/dist` with OSM enabled. That contaminated run is **not** counted in final totals. After the demo passed and stopped, `npm run build:web` rebuilt ordinary assets and all 46 selected cases ran serially. The map-job creation case passed in the clean run. Final totals above describe that completed clean run.

Scope verification: every tracked/untracked deliverable is inside key 10's allowlist. `git diff --exit-code 81b9251490cfa05eac4baecc68f6952b549a1460 -- apps/api apps/worker packages/db packages/shared packages/send-gate package.json package-lock.json apps/web/src packages/ui` passed. Only the task branch was pushed; no merge, force-push, integration/main push, live-provider action, production data change or additional cloud session.
