# SDD ledger — plan: docs/superpowers/plans/2026-10-12-roofline-storm-scout.md

Spec: docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md. Branch `s1-storm`, to be created from `e1-estimator` once E1 is merged (C1 and E1 are not built yet; at writing `origin/f3-setup` is 7b988eb). Briefs: `ops/sdd/s1/task-<N>-brief.md`; constraints: `ops/sdd/s1/global-constraints.md`. Rulings use the prefix **S**. Names marked **[C1]** / **[E1]** come from those plans and briefs and must be checked against the merged branches before each task starts.

## C1 / E1 dependencies (check against the real code when merged)

| From | Name S1 uses | S1 tasks |
|---|---|---|
| E1 T1 | migrations end at `0015`; `building_footprints` (global, GIST); `stored_files`; `STORED_FILE_KINDS` in `shared/proposals.ts` | T1, T9, T14, T19 |
| E1 T5 | `/api/public` prefix + `publicRateLimit()`; `ObjectStore`/`createObjectStore`; `FakeFootprintSource`; E1 job names | T7, T20 |
| E1 T8 | `SetupFacts.pricesAndTiersSaved` already in `shared/setup.ts` | T16 |
| E1 T13 | `R2ObjectStore`, `storeFile` | T19, T27 |
| E1 T20 | possible copy keys in `features/approvals/*` | T25 |
| E1 T21 | `seedFootprintFixture(pools)`, `apps/api/test/fixtures/footprints-ne.json` | T9, T14, T28 |
| C1 T1/T6 | `jobs.next_step`/`next_step_on` (Today follow-ups); `createJob`/`updateJob` with stage rules | T15, T20, T21 |
| C1 T1/T8 | `appointments` (`kind 'inspection'`) for "inspections booked" | T21 |
| C1 T5 | `calendar-push`/`calendar-pull` already in `JOB_NAMES`/`SCHEDULES` | T7 |
| C1 T10 | injected-`fetch` fixture test pattern | T17 |
| C1 T12 | `SetupFacts.calendarsConnected` | T16 |
| C1 T18 | `router.tsx`, `shell/apps.ts` (`shipped: boolean`, CB), `Settings.tsx`/`tabs.ts` | T22 |
| C1 CA | `features/settings/ConnectionsTab.tsx` | T22, T27 |
| C1 T27 | `?focus=` handling in `MapView.tsx` | T24 |
| C1 T28/T29, E1 T21/T22 | e2e and smoke layouts | T28, T29 |

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1↔F1 | plan says `CONSENT_SOURCES` gains `door`/`web_form`; the real array is `SMS_CONSENT_SOURCES` and already has `web_form` | gap → Ruling SF |
| T1↔E1 | `STORED_FILE_KINDS` gains `storm_photo`, `ad_image` | consistent (constant lives in E1's `proposals.ts`) |
| T2↔T3 | plan puts the CI `hail` job in T3, but T2's pytest suite needs CI first | conflict → Ruling SG |
| T3 self | plan modifies `render.yaml`; none exists | gap → Ruling SB |
| T3↔CI | plan says "migrations applied by the existing db step"; there is no such step (db suites use Testcontainers) | gap → Ruling SC |
| T4↔T6 | T6 validates without T4's logic (same wave) | consistent (plan note) |
| T6↔F3 send-gate | `decideEmail` beside `decide`; reuses `GATE_RULES`, `nextAllowedTime` | consistent |
| T6/T11/T12↔F3 send-batch | plan Ruling 6 vs T6's interface text disagree on which task adds a per-customer render hook; `send-batch.ts` has none today | conflict → Ruling SA |
| T7↔F3 | company-host pages live in `public/policies.ts` (`policyPages`); the plan says `web.ts` | consistent once named (T7 carry) |
| T7↔C1/E1 | `JOB_NAMES`, `SCHEDULES`, `AppDeps`, mounts already extended by C1 T5/E1 T5 | consistent (append) |
| T9/T14↔E1 | footprint fixture and `building_footprints` | consistent ([E1]) |
| T12/T14/T19↔T7 | each swaps its own stub in `tasks/handlers.ts` | consistent (plan Ruling 2) |
| T13↔T7 | Postmark hook mount and secret | consistent (plan Ruling 2 exception) |
| T16↔C1 T12/E1 T8 | `shared/setup.ts`, `repos/setup.ts` | consistent (T16 is S1's only editor) |
| T21↔F3 hooks | one call in `hooks/twilio.ts` after STOP/HELP/START | consistent |
| T22 self | plan names `SettingsPage`/`ConnectionsSection`; real files are `Settings.tsx`/`tabs.ts` and C1's `ConnectionsTab.tsx` | gap → Ruling SE |
| T23↔F2 | `StormWindow.tsx` replaced; F2's two-click test stays | consistent |
| T24↔F2 | `SOURCE.stormSwath`, `LAYER.stormSwathFill`, `addSourceOnce` in `layers.ts` | consistent |
| T25↔F2 | plan names `features/approvals/steps/*`; F2 has `toReviewStep.ts` and `editable.ts`, no `steps/` folder | gap → Ruling SD |

Ruling SA: Task 11 adds one optional `render(customerId) => string` input to `messaging/send-batch.ts` (the only S1 edit there), with the lease check still first in the per-customer loop — the file has no per-customer render today and T11 is the first task that needs it — cost if wrong: none (optional input).
Ruling SB: no root `render.yaml` is created; the Render background worker for `services/hail` is documented in `services/hail/README.md` as an owner setup step — the repo has no Render blueprint for the API either — cost if wrong: a manual Render setup.
Ruling SC: the CI `hail` job runs `npm run db:migrate` (Node) against a `postgis/postgis:16-3.4` service on port 54329, then `ruff check .` and `pytest -q` inside `ghcr.io/osgeo/gdal:ubuntu-small-3.8.5` with `HAIL_TEST_DATABASE_URL`; `conftest.py` gives `app_hail` a test login — the real migrator (`ensureExtensionsInPublic`, roles) must not be re-implemented in Python — cost if wrong: ~1 minute of CI.
Ruling SD: Task 25 creates `features/approvals/steps/index.ts` (a registry of per-type preview components and edit fields) and wires it with one edit each in `toReviewStep.ts` and `editable.ts` — F2 has no such folder — cost if wrong: one registry module.
Ruling SE: Task 22's settings slots are a new `storm` tab in `Settings.tsx`/`tabs.ts` (owner/office) and an `AdConnections` slot in C1's `ConnectionsTab.tsx` (Ruling CA) — the plan used placeholder names — cost if wrong: none.
Ruling SF: Task 1 appends `'door'` to `SMS_CONSENT_SOURCES` (`packages/shared/src/enums.ts`) and `0016` regenerates the CHECK; `web_form` already exists — the plan's `CONSENT_SOURCES` means this array — cost if wrong: none.
Ruling SG: Task 2 adds the whole `hail` CI job (its tests need it first); Task 3 appends only the `docker build -t roofline-hail services/hail` step — the plan put the job in T3 — cost if wrong: none.

## Waves (from the plan)

- W1: T1. W2: G1 = T4, T5, T6 · T2 (Python lane). W3: G2 = T7, T3, T22.
- W4: G3 = T8, T9, T13 · G4 = T16, T17, T18 · G5 = T23, T24, T27.
- W5: G6 = T10, T12, T14 · G7 = T20, T25, T26.
- W6: G8 = T11, T15, T19 · then T21.
- W7: T28; T29 by hand.

## Tasks

## Build log
Track lead session started 2026-10-12 (controller: Architect 1). `s1-storm` = `c1-crm` dfa9132. `e1-estimator` is still at dfa9132 (E1 T1 not built), so S1 starts with the tasks that do not need E1.
Ruling SH: `door_stops.footprint_id` and `door_exclusions.footprint_id` are `bigint` with no foreign key to `building_footprints` — same reason as Ruling EA (the global footprint table is reloaded per state and a tenant row must not block that) — cost if wrong: a dangling id shows as an address-only stop.
Ruling SI: Task 1 waits for E1 Task 1 (`stored_files`, `STORED_FILE_KINDS`, E1's 0015/0016 snapshot) so `0017` is generated once, on E1's snapshot, with the two new stored-file kinds and the `storm_photos.stored_file_id` composite FK. Meanwhile Tasks 2, 4, 5, 6 build on scratch commit `8b1cd4e` (branch `s1-scratch`, on dfa9132): T1's shared slice from the brief (`shared/storm.ts` constants and types, `shared/door-routes.ts` placeholder, two barrel lines). **Merge rule:** when Task 1 merges, add/add conflicts in `storm.ts` keep T1's constants block with the T4 logic below it; `door-routes.ts` takes T5's file; `shared/index.ts` takes T1's lines. If E1 T1 has not landed by the end of wave 2, T1 runs without the `storm_photos`/stored-file parts and a follow-up regenerates `0017` at the E1 merge (Ruling AP: never reuse a number; 0017 is unreleased).
Ruling AS (controller, 02:20Z): GitHub Actions is down (billing). Until the controller says it is back: no ci-check; verify locally (typecheck, lint, lint:css, non-Docker test projects); push task branches and merge into s1-storm on local green, each merge marked "CI PENDING". Runs wf_47b35ccc (T4-T6) and wf_58702652 (T2) were already running with ci: true; their leads' CI failures are ignored, and the S1 lead re-verifies each branch locally before merging. T2 (Python) cannot be verified on this box (no GDAL; installing it was refused), so T2 merges as CI PENDING after a careful review, and its fixture regression snapshot waits for CI.
Ruling AS correction (controller, 02:21Z): no merges into s1-storm without CI. Task branches are built, checked locally and pushed; a later wave that needs an unmerged task branches from that task branch (noted here); merges happen only after ci-check passes once CI is back. This replaces the "merge on local green / CI PENDING" lines above.
CI back (controller, 02:27Z): the repo is now public; normal rules again (ci-check, merge on green). Never commit secrets, tokens or real customer data (the MESH fixture is public NOAA data).
Merged origin/e1-estimator db9abc9 (E1 T1, CI 38194636634 green) into s1-storm: clean merge, typecheck and lint clean, playwright-core only 1.56.1. Task 1 now starts from this head (worktree /home/user/wt/s1-t1, builder sonnet per Ruling AQ: migrations and RLS); 0017 is generated on E1's 0016 snapshot (Ruling SI).
Wave 1 run wf_47b35ccc (contact 201): T4 c12f1b2 (one finding fixed, local green; CI run 38195217970 died in the billing outage, re-run queued), T5 05ec8d7 (clean, CI 38194884358 green), T6 1f5abef (one finding amended, local green; CI 38195272599 died in the outage, re-run queued).
Task 1 started (wf_16b144a0, contact 205, sonnet builders) on s1-t1 96419d8 = s1-storm 87b80cb + s1-scratch merged in (index.ts keeps the E1 and S1 skeleton lines). So s1-scratch reaches s1-storm through T1, and T4/T5/T6 merge after T1 without add/add conflicts.
Merge order: T1, then T5, T4, T6, then an integration commit for the group check's findings:
- (important, T4+T6) decideEmail: marketing email must contain companyAddress in the body, and content-block a body or subject that still holds an unfilled {first_name|company|hail_size|street|day|company_address} token ({unsubscribe} stays allowed); fix renderStormTemplate's doc, which promises a gate check the SMS gate doesn't make (Task 11/12's render hook must check too).
- (important, T5+T6) build_routes preview and minutesSaved use routes = max(reps, ceil(maxDoors / MAX_DOORS_PER_ROUTE)) and .max(MAX_DOORS_PER_PLAN) from door-routes.ts.
- (minor, T4+T6) the create_ad_campaign preview uses dailyBudgetCents (floor), not Math.round; the send_email_batch messageSample renders with renderStormTemplate sample fields; fields map keys are lower-case uuids.
Task 2 (wf_58702652, contact 204, sonnet builders): s1-t2 28a5f93. Four CI cycles taught it three things: the GDAL image is Python 3.10, the contour areas, and the tolerance. Ruling SJ: services/hail targets Python 3.10, because ghcr.io/osgeo/gdal:ubuntu-small-3.8.5 is Ubuntu 22.04 (requires-python >=3.10, ruff target py310, timezone.utc). T3 follows this. Cost if wrong: none, since 3.10 code runs on 3.12. Ruling SK: the cell-count oracle (eccodes) is checked at 8% for levels >= 500 km2. Interpolated, simplified contours run 2.8% (0.75 in) to 10.3% (3 in) below the cell count. The brief's 2% check is the regression snapshot `contour_area_km2` in expected.json (0.75=31174.4 ... 3=191.6), captured from CI run 38197381832. Cost if wrong: a looser independent check, with the 2% snapshot still guarding regressions. The S1 lead re-runs ci-check on 28a5f93. T3 carries the run's minors: download to a .part file and reject non-.gz keys in mesh.py, and loosen the nesting tolerance if it flakes.
T2 ci-check on 28a5f93: run 38198225959 PASSED (Platform + Hail). T2 is green. It merges after T1 (merge order: T1, T2, T5, T4, T6, then integration fixes).
Merged into s1-storm (--no-ff): T1 e519110 (+ report d00a792; CI 38198745859 green; review clean), T2 28a5f93 (CI 38198225959), T5 05ec8d7, T4 c12f1b2, T6 1f5abef (T4/T6 CI re-runs green after the outage). Then origin/e1-estimator d87216f (E1 T2-T5, T14, c1-crm T5/T18, F3 closed) and origin/c1-crm 9e6a459. Conflicts: packages/shared/src/steps.ts and test/steps.test.ts. Both sides added step types, so both were kept: nine step types in the registry and test, S1's three before E1's two. The merge left create_ad_campaign unclosed; 1553006 fixes it. Head 1553006: typecheck, lint and lint:css clean; shared and send-gate 1164 tests pass, web 443 pass; drizzle-kit reports no changes; migrations 0015-0018 in journal order; playwright-core only 1.56.1. ci-check (Platform, Hail, E2E) is running on 1553006.
T1 carries for later tasks: app_system has SELECT-only column grants on company_storms and ad_campaigns. If the storm-match or ad-sync fan-outs write as app_system, the task that needs it adds an UPDATE column grant and changes the rls.test.ts 42501 pin, inside a new S1 migration, which needs a controller ruling first (Ruling AP gives S1 only 0017/0018). The company_members view does not expose memberships.storm_alert_email; T16/T18 extend it if the Team page needs it.
Wave 3 launched from 1553006: run wf_076e0b7c (contact 207: T7 API skeleton, T3 hail writer/Docker, T22 web skeleton; all sonnet builders, Ruling AQ) and run wf_632328cb (contact 210: I1 integration fixes, brief ops/sdd/s1/task-i1-brief.md).
Controller (03:32Z): Rulings SH, SI, SJ, SK accepted. Ruling AW: nothing is deployed, so S1 may amend its own custom migration 0018 in place to add a grant (for example app_system UPDATE on company_storms or ad_campaigns columns). No new number and no need to ask first. Afterwards drizzle-kit must still report no changes, and the change is recorded here. Ruling AV (AGENTS.md): in hooks/twilio.ts, after the inbound message is stored, the handler order is S1 onStormReply, then G1 claims, then D1 queueFrontDeskText. A later handler skips a message an earlier one consumed, so onStormReply (Task 21) must return whether it consumed the message. T21's context must say this.
Integration sentinel (03:40Z): (1) S1's journal `when` timestamps are already above E1's: 0016 = 1791770696779 < 0017 = 1791772690993 < 0018 = 1791772862263. Checked on s1-storm, OK. (2) A1 changes StepTypeDef: minutesSaved becomes withMinutesSaved({ userCreatable, baseline, units }). When A1 reaches s1-storm, convert S1's send_email_batch, build_routes and create_ad_campaign in the merge. Until then, S1 tasks keep the current shape.
s1-storm 1553006: ci-check run 38199990221 PASSED (Platform, Hail, E2E). The wave 2 merges and the e1/c1 merge are confirmed.
Ruling AY (controller, 03:41Z): every StepTypeDef has userCreatable, baseline() and units(), and no minutesSaved (A1 T3, a1-agents 910d859). A1's TIME_BASELINES already holds S1's keys: email_sent (0.5 min, cap 120), route_built (45 min a route), ad_campaign (45 min). These replace the brief's minutesSaved numbers (A1 owns time saved). Plan: after I1 merges (it edits steps.ts), the S1 lead adds a small commit on s1-storm. That commit adds optional userCreatable/baseline/units to s1-storm's StepTypeDef, typed as a local string union of the A1 key names until a1-agents merges. Mapping: send_email_batch (userCreatable true, email_sent, units = result.sent); build_routes (true, route_built, units = result.routes); create_ad_campaign (true, ad_campaign, units = result.campaigns, which T19's handler must report as { campaigns: 1 } when it creates one). minutesSaved stays until the A1 merge, which takes A1's interface and drops it.
I1 (wf_632328cb, contact 210): 3b4473b (+ report 83976b6). One finding was fixed and the review came back clean; CI 38200468372 green. Merged into s1-storm. Behaviour change: the ad preview floors the daily amount (15000 over 7 days shows $21.42).
Carries for T11/T12 (from the I1 group check), which their contexts must include:
- tasks/service.ts previewFacts also handles send_email_batch: recipientCount, sampleFirstName (the same lookup as SMS) and companyAddress from the company postal address. Otherwise the preview shows a raw {company_address}. Extend PreviewFacts with an optional companyAddress.
- T12 renders the subject and body with renderStormTemplate, giving every StormFields key: first_name from the customer, company, hail_size, street from fields with a fallback when missing, day from the storm, company_address exactly equal to the string passed to decideEmail, and unsubscribe. It then passes the plain-text body (not the HTML) to decideEmail. Otherwise every storm email is blocked as a blank or as a missing address.
- The SMS path (T11) refuses a rendered body that still holds a storm token.
Ruling AY commit e57f982 (branch s1-ay; CI 38201627216 green) merged into s1-storm. S1 step types now have userCreatable/baseline/units. minutesSaved follows A1 baselines from the result: email 0.5 per email sent capped at 120, route 45 per route built (was 120 per planned route), campaign 45 per campaign created. T19 must report { campaigns: 1 } and T14 must report { routes: n }.
Wave 3 (wf_076e0b7c, contact 207, sonnet builders): T7 9091cc8 (one finding amended, then a clean review; CI 38200968482), T22 78665ec (clean; CI 38200988107), T3 3821ff5 (one fix round, then a clean review; CI 38204465906 on 453f208 with Platform and Hail; the later commit is report-only). Merged in order T7, T22, T3 with no conflicts. Head a43f3e4: typecheck, lint and lint:css clean; shared/send-gate 1182 and web 457 tests pass; playwright-core is only 1.56.1.
Carries from the contact-207 group check:
- T20: stormPage is mounted at the app root on every host. storm-page.ts must match the company host the way policyPages does and call next() for any other host. Add a test that GET /storm/<uuid> on the app host still reaches the web app. /api/public/storm-requests sits behind blockCrossSiteMutations(APP_ORIGIN), so the landing form POST from <slug>.<POLICY_PAGES_DOMAIN> would get 403. Mount it ahead of the guard with its own Origin check (the company host for that code), and test with a company-host Origin header.
- T10: hail-health measures freshness only from status = 'processed' rows (newest valid_at), because T3's record_failure writes failed rows with valid_at = now(). The hail worker already emails ops after 3 consecutive failed ticks, so T10's alert is for stale data.
- T18/T27: one name for the Meta account across the copy files (for example 'Facebook and Instagram (Meta)'), and only one coming-soon line in the Connections tab (drop connections.later or ads.connectionsComingSoon).
- T10/T11: worker.ts isJobData checks only companyId. Storm job handlers must validate companyStormId and kind.
- Whole-branch review: services/hail run.py treats every 12:xx UTC grid as final (the brief says "hour is 12Z"). The :05 and :35 ticks can both run final. Consider "final once per day" (no processed final run yet for that day).
CI rule (controller 04:52Z): ci-check runs with CI_JOBS="Platform E2E Hail" for S1, and a merge needs every judged job green. Wave 4 runs (wf_6370bd6d, wf_f8bef930) were launched judging only Platform, so the S1 lead checks E2E and Hail on each branch's CI run before merging. Earlier merges were confirmed by integration-head runs that judged all three (38199990221 on 1553006; 538dcdd running).
Sentinel pass 2 (05:00Z): (1) S1 journal `when` values are newer than D1/A1/G1. The controller raises the later tracks when they combine (Ruling AP); S1 does not regenerate. (2) At the a1-agents merge: take A1's StepTypeDef, drop S1's optional userCreatable/baseline/units members, StormBaselineKey and minutesSaved, and change packages/shared/test/steps-storm.test.ts to stepMinutes(def, p, result).minutes. The launch-integration probe CI 38204712356 has the Hail service green.
s1-storm 538dcdd (wave 3 + AY + I1): ci-check run 38205684196 PASSED (Platform, Hail, E2E).
Sentinel pass 3 (05:46Z), merge notes for when a1-agents/d1-front-desk reach s1-storm. Storm is the last app to ship, so no dock app says Coming soon. Settings has 11 tabs: company, team, prices, schedule, connections, storm, billing, setup, front-desk, agents, profile. Updates: a1-dock.test.tsx (drop Storm Coming soon and storm: false); a1-settings.test.tsx (11 tabs); d1-routes.test.tsx (no Storm Coming soon); d1-settings.test.tsx (storm after connections in ALL); router.tsx (once no placeholder is left, drop the unused comingSoonWindow, ComingSoon and ComingSoonKey imports). The probe is green with these applied (38207792011).
Wave 4a (wf_6370bd6d, contact 212): T8 2646dbe (spotter sync, storm layer at /api/map/storm-layer plus an alias /api/storms/layer; one fix round, clean review; CI 38209235927 all jobs), T9 ef37e7c (company storms and hits, storm-match fan-out; per-company writes run as app_tenant, 0018 unchanged; testing fixtures in @roofline/db/testing storms.ts; CI 38208363292 on ee63a7a all jobs, the later commit is report-only), T13 9dd217d (Postmark broadcast, /u unsubscribe page and one-click, /hooks/postmark; CI 38207983082 all jobs). Merged in order T8, T9, T13. Only app.ts was shared (different hunks, auto-merged); progress.md kept the lead's version, and T13's decision is restated here.
T13 decision: the app has no SESSION_SECRET, so unsubscribe tokens use unsubscribeKey(config) (public/unsubscribe-key.ts, an HKDF of ENCRYPTION_KEY with info 'unsubscribe') and signUnsubscribeToken (public/unsubscribe-token.ts; payload base64url('companyId|email')). recordEmailOptOut is raw SQL naming company_id, email and source. 0018 unchanged.
Carries (contact-212 group check):
- T12 signs unsubscribe tokens with signUnsubscribeToken(unsubscribeKey(config), ...) from T13's helpers. This overrides the T12 brief's "stateless HMAC of companyId.emailLower".
- T9's thresholdContourInArea returns a GeoJSON string or null: the outermost contour at or above the threshold. T10, T14/T15 and T17/T18 JSON.parse it.
- T21: routes/storms.ts stormRoutes already mounts '/layer' (T8) before the 404 fallthrough. Keep it ahead of '/:id' and keep layerHandler/stormLayerRoutes.
- T24: take the legend label from web copy and ignore the swath properties.label.
- Follow-up (whole-branch review): CURRENT_COMPANY is duplicated in repos/company-storms.ts and storm-hits.ts; SpotterReport is declared twice (structurally checked).
- I2 (web integration fixes): hail fill now uses hailFillExpression() keyed on thresholdIn everywhere (layers.ts, StormSwathMap); one hail palette and legend copy (mapCopy.hailLegend/hailSizeLevels); StormWindow shows staleBanner from the real useStormLayer call (layer.data?.stale). Gate green: typecheck, lint, lint:css, web 522 tests. See task-i2-report.md.
