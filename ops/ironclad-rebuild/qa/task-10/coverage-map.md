# Task 10 contract audit and regression map

Baseline: `81b9251490cfa05eac4baecc68f6952b549a1460`, descended from complete launch-rc3 `ff772d5cbf87eac051759e9049fb29930845a45f`. This is baseline QA plus new regression coverage, not a review of the assembled redesign. No production file is changed by this task.

`contract-inventory.json` records the actual router paths, 39 HTTP modules, their exported declarations/request paths and SHA-256 digests. Request paths containing interpolation are source patterns, not executable URLs. The inventory covers 1,131 tracked files across API, worker, DB, shared and send-gate scopes. It is an audit artifact, not a substitute for behavioral tests.

| Surface and actual entry points | Contract/action that must survive | Behavioral evidence to rerun after integration |
| --- | --- | --- |
| `/sign-in`, `/sign-up`, `/reset`, `/verify`, `/invite`; protected shell | Form-local 401; session/login/logout cache clearing; no staff gate on public links | `auth`, `signup`, `client`, route tests; signup E2E |
| Account menu; `/approvals/:taskId`, all ID detail routes | Switch writes `{companyId}`, updates account, navigates home, discards old-company query data; old URLs remain server-scoped | Existing `company-switch`; new task-10 detail-unmount test and desktop/390px stack regression |
| `/settings/company`, `/settings/team`, `/settings/billing` | Owner administration/billing; office message/internal approval, delegated spend only; rep-assigned data and hidden money | `settings-team`, `billing`, `agents-money`, `rep-visibility`; CRM E2E |
| Canceled/trial-ended company | Reads and billing recovery remain; most writes 403; Front Desk OFF remains allowed and saves only enabled=false; transfer-phone remains blocked | Existing read-only API and Front Desk settings API suites; new canceled-company E2E verifies persisted state after reload and rejected writes |
| `/approvals`, `/approvals/:taskId`, `/storm/plans/:taskId` | Current waiting `{id,version}` list includes disabled and owner-only steps; pending edits lock approval; 409 preserves latest; optimistic rollback affects only the failed step; queued does not mean delivered | Existing `review`, `approvals-*`, API edit/approve; new overlap, pending/conflict unit tests and real stale-tab office E2E |
| `/customers`, `/jobs`, detail/create routes and timeline | Search/paging, assignment, stage rules/Lost reason, archive/restore, notes and real mutations; rep scope and monetary redaction | Customer/job/timeline unit tests; CRM E2E; DB scopes and API rep-visibility |
| `/jobs/:jobId/quotes/:quoteId` | PATCH draft; POST finalize/copy; frozen pricing; actual `/api/quotes/:id/pdf` response | Quote editor tests and CRM quote finalize/PDF E2E |
| `/estimator`, `/estimator/measure/:measurementId`, `/estimator/proposals/:proposalId` | Property/address measurement; report spend approval; tier/options/revision; grouped status paging; send returns a taskId requiring approval | Estimator/measure/proposal tests; estimator E2E; proposal API suites |
| `/p/:token` | Signed-out, cookie-free public requests; explicit consent/signature; no staff redirect on 401; 409/410 invalidate; contact recovery; PDF polls every 5 seconds, up to 24 reads | Existing homeowner unit tests and signing/PDF API suites; homeowner E2E; new encoded-token sign-error tests |
| `/front-desk`, `/front-desk/:conversationId` | Inbox/read/unread/live polling, transcript/action/recording, reply versus team handling, spam; selective inbox invalidation; opt-out/send failures stay visible | D1 tests and Front Desk E2E; new blocked-reply versus handling contract test |
| `/settings/front-desk`, `/settings/profile` | On/off, forwarding verification, owner override, recording acknowledgment, on-call order, transfer phone | Front Desk settings API and D1 tests; canceled-company E2E |
| `/calendar`, `/calendar/new`, `/calendar/appointments/:appointmentId` | Company-zone availability/conflicts, real booking/edit/actions, job auto-stage, provider connection and sync | Appointment/calendar unit and API tests; calendar E2E |
| `/storm`, `/storm/:id`, `/storm/routes`, `/storm/routes/:routeId` | Draft/re-draft/pause conflicts, bounded spend approval, results, door outcomes, real route writes | Storm/doors/public-forms E2E and API suites; existing storm web tests |
| `/agents`, `/agents/feed`, `/agents/waiting`, `/agents/:agent`, job claim section | Pause confirmation, run cooldown, owner recount/dry-run, role-filtered feed, waiting approvals, claim packets; snapshot-based estimates | Agent/claims unit and API tests; agents/settings/more-agents E2E |
| Map, `/today`, weather and search | Bounds order, points/clusters, layers, safe selection, real summaries/acknowledgment, no guessed metrics | Map/Today/search tests; shell/Today/phone E2E |
| Setup/import/texting/deep links | Upload/preview/consent/progress/export; billing and paid-action guards; invalidations | Setup/import/texting unit and API tests; setup/import/billing E2E |
| Demo probe/badge and four simulations | GET probe is false outside demo; POST text/call/storm/sign only in demo, with session/capability/read-only/Origin guards; success invalidates real reads, failure does not manufacture state | Demo routes API (isolated fake demo); existing separate demo walkthrough; new non-demo stack test and four hook regressions |

## Visual evidence limits

Inspected all ten committed JPEGs: desktop home, Front Desk, Pipeline, Measure, Schedule, Storm, Agents, Claims at 1440×900, and home/Front Desk at 390×844. Read both measured-style JSON files and reference README. The compact 34px desktop header, map-backed widgets, 1400×766 Front Desk panel, graphite/neutral surfaces, colored app dock and phone stacking are the design authority. These synthetic figures are not Roofline data.

Task 10 changes no UI. Runtime screenshots from this branch therefore show the pre-redesign baseline. A blank map in the fake test stack is expected: its no-key map style deliberately makes no remote tile calls. No exact visual-fidelity pass is claimed. Shared shell geometry and integrated screens must be recaptured after the controller assembles all owners' changes.

## Integration requests

1. Preserve all route/action rows above when integrating the nine UI owners. Task 10 has not merged their branches and cannot certify that assembled behavior.
2. Re-run the new regression spec in the normal desktop project: it contains both exact reference viewport groups. The existing phone project only discovers `phone.spec` and `doors.spec`; controller may change discovery, but should avoid running both explicit groups twice.
3. Existing `shell.spec.ts` asserts the old 1280px maximum window width. Controller must adapt intentional geometry assertions against measured reference values, preserving navigation/focus/one-window checks. Task 10 does not edit existing tests.
4. The separate demo walkthrough has optional `clickFirst` visits: passing it alone cannot prove every detail opens. Keep the specific workflow suites alongside it.
5. A new company-switch test detects an old-ID refetch after the switch response despite `await navigate('/')`. Reproduced in Chromium at both 1440×900 and 390×844, as well as the hook/router test. Keep its assertion; controller owns shared hooks/integration and must review React commit timing. Server tenant rejection and actual-browser behavior are checked separately. This finding alone is not evidence of cross-company data disclosure.

## Available sibling change audit

Read-only review of Task 01 at `ef55d423fd2356cdde41e7e20ee1c3e06d92bf68` (the only published sibling at the time of inspection): 35 changed files, predominantly styles/tokens. Reviewed all TSX deltas. `Window.titleIcon` is optional/decorative and leaves title, description, focus trap and close handler intact; Dock preserves labels, badge labels, hrefs and current state; AppWindow still uses the existing navigation and phone variant; MoreSheet retains its link list and close callbacks. No API/hook/backend mutation or routing changes in that diff. This source review does not execute Task 01 or establish integrated visual/accessibility success. Tasks 02–09 were not yet published when inspected.
