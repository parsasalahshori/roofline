# Task 10 — backend contract preservation and regression QA

Branch: `codex/ironclad-full-ui-10`. Exact preparation baseline: `81b9251490cfa05eac4baecc68f6952b549a1460`; verified ancestor: `ff772d5cbf87eac051759e9049fb29930845a45f`. Implementation SHA and final CI observations will be recorded in the follow-up report commit after pushing the test changes.

## Result and integration blocker

QA-only scope: no production, backend, provider, worker, database, send-gate, HTTP hook, business helper, dependency, lockfile, router or shared-export edits. Added 11 hook/UI regressions and seven real-stack Playwright scenarios, with explicit 1440×900 and 390×844 groups. The new tests intentionally retain a reproducible baseline failure; this branch is **not green and must not be treated as whole-product readiness**.

**T10-01 — company-switch query reset races React detail unmount (controller fix required).** In `apps/web/src/api/hooks.ts`, `useSwitchCompany` awaits navigation, then resets all non-account queries. Both the real Chromium browser (desktop and phone reference sizes) and the hook/router test observe another GET for the old approval ID after the company-switch response. Awaiting navigation did not ensure that the old query observer had unmounted. The unit reproduction uses a realistic 404 after the switch and still verifies cache clearing and the new account. Browser checks verify the old plan disappears, the switched account is correct, direct access returns 404, and the old URL cannot render approval controls. No cross-company data disclosure was observed. Keep the no-old-ID-refetch assertion; review navigation commit/unmount ordering in a separately authorized controller fix. Task 10 cannot edit frozen hooks.

## Deliverables

- `apps/web/test/ironclad-full-10.test.tsx`: company-switch detail/cache ordering; overlapping optimistic edit rollback; pending-edit approval lock and 409 latest-version reconciliation including disabled and owner-only steps; public sign 401/409/410 cookie-free behavior and encoded token; blocked reply versus team handoff and selective invalidation; all four demo simulation mutation/error contracts.
- `apps/web/e2e/ironclad-full-regression.spec.ts`: real canceled-company read-only/billing recovery/Front Desk OFF persistence, blocked re-enable/transfer/customer writes; office stale-tab conflict and owner-only spend; company switching and server isolation; non-demo UI/probe and four absent simulation routes. Uses existing fake providers and disposable test DB helpers. No intercepted backend responses.
- `ops/ironclad-rebuild/qa/task-10/contract-inventory.json`: actual router paths and 39 frozen HTTP module signatures, request patterns and SHA-256 digests; tracked frozen-scope counts and no changed frozen paths.
- `ops/ironclad-rebuild/qa/task-10/coverage-map.md`: route/action/role/demo preservation inventory, existing coverage, integration requests and bounded Task 01 source audit.
- Runtime screenshots and check evidence under `qa/task-10/`, recorded in the final follow-up below.

## Checks observed before first test commit

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
| New stack regressions / existing E2E / demo tour | Execution in progress at first commit; final results below will supersede this row. |

## Visual and change-audit limits

Inspected all ten committed reference JPEGs and both measured-style JSON files. Reference desktop is 1440×900 and phone is 390×844. Baseline runtime screenshots are not an integrated redesign comparison. The fixture map deliberately avoids remote tiles; no reference synthetic metrics were copied into application data.

Read-only audited Task 01 `ef55d423fd2356cdde41e7e20ee1c3e06d92bf68` (35 files). TSX changes retain existing hrefs, role labels, badge semantics, close/navigation/focus wiring; the new Window titleIcon is optional and decorative. No frozen-contract drift in that diff. Other UI task branches were not published at inspection; none were merged here. Controller must repeat the workflow and screenshot checks on the assembled redesign.

Controller also owns adaptation of the old 1280px shell geometry assertion and any desired phone-project discovery changes. Preserve behavioral assertions when adapting visuals. Full local `npm test`, all E2E files, local v1, ARM64 and Hail were not run by this task; real CI status must be checked for all five areas, not inferred from baseline tests or documentation-only commits.

## Final evidence and CI

Pending first push and completion of remaining local runs. This pending marker is an honest intermediate report, not a success claim.
