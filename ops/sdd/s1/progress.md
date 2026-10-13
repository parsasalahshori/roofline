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
Wave 4b (wf_f8bef930, contact 215): T23 e7be4c8 (Storm window and detail; CI 38209864404 all jobs), T24 db514d9 (map storm layer; CI 38208183774 all jobs), T27 da615d7 (Storm settings and ad connections; CI 38209759100 all jobs). Each branch was green alone, but the group check found two critical cross-task bugs: map swaths coloured by a missing `level` property (every swath drawn hail-1), and the Storm window's layer call without a bbox (400, so the stale banner never shows). So these three don't go straight into s1-storm. They are merged on integration branch s1-i2 (T24, T27, T23; conflicts in copy/storm.ts and test/s1-routes.test.tsx resolved by the lead in e5e18b1: single quotes, both *ComingSoon keys dropped, both comingSoon/ads imports dropped). Merged tree local: typecheck, lint, lint:css clean; web 518 tests. I2 (brief task-i2-brief.md; wf_ea1f6473, contact 221, sonnet) fixes them on s1-i2. s1-i2 merges into s1-storm once green.
Carries from T27: it assumes GET /api/ads/accounts -> { accounts, managerId, businessId }; T16 (running) must match, or a follow-up aligns them. Check the storm emails toggle (emailEnabled, "Send storm emails") against the spec. A photo upload race can orphan a stored object, and photo DELETE keeps the stored_files row (no DELETE grant on stored_files). Left for the whole-branch review.
s1-storm e12438a (T8, T9, T13): ci-check 38210901387 PASSED (Platform, Hail, E2E). 05:5x-06:20Z: the account session limit stopped runs wf_f046ef1d (T16-T18: builders done, uncommitted in their worktrees; review/commit failed) and wf_ea1f6473 (I2 plan failed). Both resumed at 06:22 from their journals with the same args.
Sentinel pass 4 (06:33Z; probe green 38211391217): at the next e1-estimator merge, apps/web/test/s1-routes.test.tsx "the dock Storm opens /storm" needs signedInApi(ACCOUNT, { 'GET /api/proposals': () => ({ body: { proposals: [], total: 0 } }) }), because E1 T15 EstimatorWindow fetches it (see e1-routes.test.tsx:98; the probe carries it as 90a79bf). A1 has already converted the S1 step types on its side; s1-storm keeps minutesSaved until it merges a1-agents.
- I2 (web integration fixes): hail fill now uses hailFillExpression() keyed on thresholdIn everywhere (layers.ts, StormSwathMap); one hail palette and legend copy (mapCopy.hailLegend/hailSizeLevels); StormWindow shows staleBanner from the real useStormLayer call (layer.data?.stale). Gate green: typecheck, lint, lint:css, web 522 tests. See task-i2-report.md.
s1-i2 (T24, T27, T23 + I2 0f43a12; I2 contact 221, clean, CI 38212848887 Platform/E2E/Hail) merged into s1-storm. I2 fixed both criticals (swaths coloured by thresholdIn via hailFillExpression; the Storm window stale banner uses T24's useStormLayer with the company bounds from useMapArea at zoom 6), made one hail palette and legend (shell/map/stormLayer.ts), moved query keys into api/keys.ts, added the malformed-body guard and removed the unused comingSoon.storm. Minor for the whole-branch review: layers.ts and stormLayer.ts import each other (works, because STORM_LAYERS moved inside the function); StormSwathMap legend swatches keep CSS data-level token rules.
Wave 5 G6 launched from f19f8bb: wf_e9d2c7a2 (contact 223, sonnet builders): T10 alerts and settle, T12 send_email_batch and the email path, T14 build_routes. Each context carries its items from this ledger (T10 freshness/isJobData/storm_alert_email; T12 unsubscribe helpers, full renderStormTemplate fields, previewFacts companyAddress, result.sent; T14 thresholdContourInArea GeoJSON, testing fixtures, result.routes). G7 (T20, T25, T26) follows when wf_f046ef1d (T16-T18) finishes.
s1-storm f19f8bb (wave 4 complete: T8, T9, T13, T23, T24, T27, I2): ci-check 38214691012 PASSED (Platform, Hail, E2E).
Sentinel pass 5 (07:16Z, probe green 38214809818): A1 T14 adds a Storm Scout pause check to apps/api/src/storm/plan.ts (stub). Its apps/api/test/storm-pause.test.ts second test expects draftStormPlan to fail with "not yet". When T11 fills in the drafting body, that test must expect a drafted task instead: fix it in T11 or at the T11 + a1-agents merge. The s1-routes GET /api/proposals stub is still open for the next e1-estimator merge.
Controller (07:21Z, from A1): a1-agents puts A1 T14's Storm Scout pause check at the top of draftStormPlan (apps/api/src/storm/plan.ts). T11 must keep that check before the draft insert and update apps/api/test/storm-pause.test.ts to expect a drafted task, wherever the two meet. A1's "run now" (storm-match-company) throws "not yet" only on a1-agents. s1-storm already has T9's match.ts, so this resolves at the a1-agents merge. T11 context must carry this.
G4 (wf_f046ef1d, contact 218; resumed after the session limit): T16 30578ca (ad account linking; two review rounds then a clean review; 0018 amended under Ruling AW with GRANT SELECT (company_id, status) ON ad_accounts TO app_system plus the app_system_all policy, and rls.test.ts extended; CI 38216783311 Platform/E2E/Hail), T17 6db4787 (Google Ads adapter; CI 38213113947), T18 b7c3a2c (Meta adapter; CI 38213459869). Merged T16, T17, T18 with no conflicts. Head 527e406 local: typecheck and lint clean, shared/send-gate 1184 tests pass, drizzle-kit reports no changes. Note: T16's lead ran ci-check from the s1-t12 worktree by mistake. s1-t12 was at e9ec323 locally and remotely, so the push was a no-op.
I3 carries (contact-218 group check), to build as I3 or fold into T19:
- (important) Revoking a Google account must end our manager link. T17 has no AdsGoogle.unlink, and T16 calls unlink?.(), so today a removed account keeps our access. Add link.unlink (search customer_client_link for the client; ACTIVE -> INACTIVE, PENDING -> CANCELED, via customerClientLinks:mutate with updateMask status; none -> no-op), wire it in googleAdsFor, add fixtures and tests, make unlink required, and drop the ?. in revokeAdAccount.
- (important) Meta verifyAccess turns every error into not_shared/not_assigned, including rate limits, network failures and our own expired token. Map only permission/unknown-object codes (100/subcode 33, 10, 200-299) to not_shared/not_assigned and rethrow the rest, so T16's fromThrow handling runs. Test that a rate-limit error is thrown.
- (minor) checkAdAccount re-invites on linkStatus 'refused' as well as 'none'; test it with the fake set to refused.
- (minor, review) google-ads/index.ts and http.ts use double quotes (repo style is single). checkAdAccount makes up to 3 GAQL searches per click.
- T17's notes: AdsGoogle.unlink becomes required after the fix. mapMetaError checks 'rejected' before payment.
G6 (wf_e9d2c7a2, contact 223, sonnet): T10 d06ffd2 (owner storm alerts, the settle trigger and hail-health; 0018 amended in place under Ruling AW: SELECT ON hail_runs TO app_system, and the company_members view gains storm_alert_email as its last column, with rls.test.ts updated; clean; CI 38215967371), T12 e9ec323 (send_email_batch and the email send path; CI 38217786362), T14 24e9bf8 (build_routes; CI 38218055743). All three ran all CI jobs. Merged in order T10, T12, T14. Conflicts in apps/api/src/tasks/handlers.ts and test/storm-skeleton.test.ts: both handlers are wired, only create_ad_campaign stays the 'not yet' stub, and the doc comment was updated. Head b06f4fb local: typecheck and lint clean, 1184 tests pass, drizzle-kit reports no changes.
Carries / minors (whole-branch review): OPS_ALERT_EMAIL is undocumented in .env.example and the README. hail-health emails only in the 15-minute window after the threshold is crossed, so a missed tick can skip it. A stale SHELL comment remains in repos/storm-alerts.ts. The storm-match "alerts once" test doesn't assert alertsAfterFirst > 0. claimNowAlert sets alerted_at before sending, so a crash loses that alert. Owner alerts use deps.mailer directly with no opt-out (intended: staff, not customers).
Merged origin/e1-estimator e29d2d8 (E1 T7, T8, T15; C1 waves 4-5: T6 stage rules, T13, T14, T16, T20, T21, T24-T27) into s1-storm as ca89886; c1-crm was already contained. Nine conflicts:
- setup (shared/db): both sides kept; SetupFacts has ads + calendarsConnected + pricesAndTiersSaved.
- shared setup.test.ts: both sides kept.
- rls.test.ts: APP_TENANT_DELETE_TABLES = opt_outs, calendar_busy_blocks, calendar_event_links, calendar_connections, door_exclusions, storm_photos.
- copy/connections.ts: S1 ad keys plus C1 calendar keys. S1's `connect` renamed `adConnect` (C1's `connect` is the per-provider calendar object). One `later` line ('More connections are coming with setup.').
- ConnectionsTab: CalendarConnection, AdConnections, then the later line.
- MapView: both effects kept (T24 storm layer, C1 T27 ?focus=).
- f3-routes and settings tests: both stubs.
Follow-up test fixes: team-member fixtures carry stormAlertEmail; the sentinel's s1-routes GET /api/proposals stub; calendar/company stubs in s1-routes and settings-ads; storm-layer in map-focus. Local: typecheck, lint, lint:css clean; web 790, shared/send-gate 1192; drizzle-kit reports no changes; playwright-core only 1.56.1. E1 T13 (storeFile) is not on e1-estimator yet, so T19 waits.
s1-storm 65f130b (G4 + G6 + the e1-estimator e29d2d8 merge): ci-check 38221280266 PASSED (Platform, Hail, E2E). The two earlier runs (527e406, 28cd486) had Platform cancelled by later pushes. Lead practice: no s1-storm pushes while an integration ci-check runs.
Controller (08:28Z, from A1): T19 brief now says the step result is { campaigns: 1, circles, dailyBudgetCents, days, housingFallback: 0|1 } (numbers only; the campaign id lives on the ad_campaigns row); error copy goes in copy/storm.ts because copy/ads.ts was deleted by T27.
Controller (09:07Z): C1 is complete; its lead session_01MpVA7xTz6Bus8WPNZWUKRq helps S1. Handed over T19 (ad campaign handler; scratch storeFile commit per E1 T13 brief line 16 if E1 T13 has not landed; merge rule: E1 wins) and T29 (smoke scripts and runbook only, every live step behind assertConfirmed, never run live). Base 3838a7d. The C1 lead builds on s1-t19/s1-t29 with CI green on Platform/E2E/Hail and reports back. The S1 lead keeps merges and the ledger.
G8 (wf_a6da8851, contact 229): T11 124a945 (storm plan drafting; Ruling SA render hook in send-batch.ts with the lease check still first; the SMS path blocks a rendered body that still holds a storm token; draftStormPlan(deps, companyId, companyStormId, now) -> { taskId } has the A1 T14 marker comment first; CI 38223238113 all jobs), T15 88c6bd7 (+ report 96c5827; door outcomes and leads from doors; CI 38223749281 all jobs). Both merged (no conflicts; head 8d47456). T26 f112785 (phone routes; CI 38226490129 all jobs) is NOT merged directly. Contract with T15: the web expects stopCount/doneCount, but the API sends stops/doneStops (critical). The web also types address and hailIn as non-null where the API sends null for footprint-only homes. WantsCheckSheet shows 'Not saved, try again' for a 409 duplicate phone. T26 therefore goes through integration branch s1-i4 with I4 (brief task-i4-brief.md).
Carries: at the a1-agents merge, A1 T14's pause check stays first in draftStormPlan (at T11's marker) and storm-pause.test.ts expects a drafted task. Reps are ordered by user_id: company_members has no created_at. Review minors: draftStormPlan throws a plain Error for a missing or dismissed storm (the job retries a permanent failure); send-batch parses the payload twice; T15 placeFor keeps a leftover void tx/ctx.
- I3 (s1-i3): Google unlink on revoke, Meta outage vs not shared, re-invite after refusal. Done; see task-i3-report.md.
- T25 review-fix (s1-t25 3b121f7; web only): the create_ad_campaign thumbnail draws the storm's hail swath (outer rings of the swath, SwathThumb), not the ad circles, because no circles reach the web on this base (the ad providers compute them inside the api; no task yet puts circles on the payload, and createAdPayload is strict, so a later task must add a circles key to the schema or keep it out of toPayload). The ad photo choice reads the company's Settings photos (useStormSettings(enabled)); the approved maximum stays the ceiling, and Edit may lower it only. Gate: typecheck, lint, lint:css clean; step-ads, step-fields-sheet, review, copy-rules, lint-rules, step-wiring, to-review-step, settings-storm green.
Wave 5b (wf_90b20796, contact 226): I3 a3856d1 (Google unlink on revoke, now a required member; Meta permission errors vs outages; re-invite on 'refused'; CI 38221927271), T20 4eeee6a (storm landing page and requests; stormPage is mounted before policyPages and is host-gated; the storm-requests router sits ahead of blockCrossSiteMutations with its own company-host Origin guard; consent opt-in with evidence; CI 38228506054 on 3cffbf6, the later commit is report-only), T25 3b121f7 (approvals previews and Edit for the storm steps, Ruling SD steps/ registry; CI 38222418416). All three ran all jobs. Merged in order I3, T20, T25; only progress.md conflicted (both sides kept).
Carries: the ad landing URL is not wired yet. ensureStormPage (T20) plus companyOriginFor give https://<slug>.<POLICY_PAGES_DOMAIN>/storm/<code>; T19 (C1 lead) and the email path must use them, so tell the C1 lead. Review minors: storm-page accepts /^[a-z2-7]{8}$/i but storm-requests accepts /^[a-z0-9]{1,32}$/ (share one regex). publicRateLimit sits outside the form error handler, so no-JS visitors get a JSON 429. storm-requests inserts the job directly rather than through createJob, because createJob has no stormId/nextStep. A typed address that belongs to another customer attaches the request to that customer (intended; note it for the owner).
I4 (s1-i4, phone routes vs the real door API): web reads stops/doneStops, null address/hailIn (doors.noAddress), duplicate-phone error on the phone field. Reviews: R1 2 findings (fixed/amended), R2 0. Local verify clean (web 830 tests). Report: task-i4-report.md.
s1-storm 64447d6 (T11, T15, I3, T20, T25): ci-check 38231034811 PASSED (Platform, Hail, E2E).
I4 (wf_fca30448, contact 232): cb3b1b9 on s1-i4 (T26 phone routes now match T15's API: stops/doneStops, null address/hail with doors.noAddress, the duplicate-phone 409 shown on the phone field, shared DOOR_OUTCOMES, --stage-lead token for the self dot; one amend round, then clean; CI 38230094771 Platform/E2E/Hail). s1-i4 merged into s1-storm as 97414da; local web 888 tests, typecheck/lint/lint:css clean. Review minors: the server phone error stays until the next submit; the self dot reuses --stage-lead (a --map-self token would be cleaner).
s1-storm c510ea8 (+ T26/I4): ci-check 38233683925 PASSED (Platform, Hail, E2E).
T29 (built by the C1 lead, run wf_8143b7ff, contact 76): e611a4e. smoke:storm script, docs/superpowers/s1-manual-smoke.md and guard tests; every live step is behind assertConfirmed and the owner's env credentials, and nothing was run. CI 38229690978 Platform/E2E/Hail. Merged into s1-storm (no conflicts; local typecheck and lint clean). Carry: after T19 merges, the smoke should render the real ad card through resvgCardFor instead of a 1x1 PNG (storm.ts:59, runbook :81), a one-line follow-up. The owner runs the smoke (OWNER TO-DO: Google and Meta test accounts, a Postmark broadcast stream, a real MESH run).
T19 is green at ff02a51 (CI 38234595026). The C1 lead is merging s1-storm into s1-t19 to wire landingUrl through ensureStormPage + companyOriginFor; the merge waits for its new head. T19 notes: no grant change (spend writes run as app_tenant); the ad image follows T27's stored_files pattern (no storeFile scratch); adErrorCopy is in copy/connections.ts with a duplicate AD_ERROR_COPY in storm/ad-campaign.ts (minor); Review Focus 1 holds.
T21 (wf_07f27434, contact 233, sonnet): ef034b2. YES replies via onStormReply -> { consumed }, called in hooks/twilio.ts after the inbound store, with the G1/D1 slot marked (Ruling AV). A YES attaches only to the newest storm text within 14 days, and only once. Also storm results (13 counts) and the storms API matching T23's web types (GET /, GET /:id, POST /:id/dismiss, POST /:id/plan; /layer stays first). One CI fix round; CI 38234997601 on 99af3e5 all jobs. Merged into s1-storm; local typecheck/lint clean, 1192 + web 888 tests.
Whole-branch review items from T21: (1) Redrafting an expired or declined plan returns the old taskId (T11 replaceDraftPlan replaces only drafts, and the route allows only 'draft'). Review Focus 4 forbids replacing a running or approved plan, not an expired or declined one, so draftStormPlan should replace those too and the route should allow them. (2) Export plan.ts's error-message constants and import them in routes/storms.ts (it matches on copied text). (3) GET /api/storms ignores ?since=. (4) The storm_id backfill on an existing job in replies.ts writes no audit row.
s1-storm T21 head: ci-check 38237669360 PASSED (Platform, Hail, E2E); covers T29 too.
T19 (C1 lead, Sonnet builders): d15bdc1 (already contains s1-storm with T20/I3/T26). create_ad_campaign handler, creative card and spend sync. The ad landing URL comes from ensureStormPage + companyOriginFor (in public/storm-requests.ts). Review Focus 1 holds: the approval, approver and payload are re-checked before any platform call; a revoked account gets no call and failed:access; retries search by name tag first; budget x days <= max; the 95% pause is retried every run. No grant or migration change. CI 38237639710 Platform/E2E/Hail/v1. Merged into s1-storm; local typecheck/lint/lint:css clean, 1192 + web 888 tests, drizzle-kit reports no changes. All plan steps now have real handlers.
I5 (to the C1 lead), from T19's carries:
(a) A campaign running past the storm page's active_until (convective day + 30) points at an expired page. Creating a campaign extends the page's active_until to at least the campaign end date + 1 day.
(b) When POLICY_PAGES_DOMAIN is unset, the PUBLIC_BASE_URL/storm/<code> fallback hits the web SPA's /storm/:id route, not the landing page. The step fails before any spend instead (needs attention, plain reason 'Storm landing pages are not set up yet.').
(c) The smoke renders the real card via resvgCardFor (T29 carry).
(d) Remove the duplicate AD_ERROR_COPY in the API, or document why it is kept.
Merged origin/c1-crm 5d2e3bd (C1 complete: T28 e2e, whole-branch review fixes) and origin/e1-estimator 3dc8fee (E1 T10-T13, T20; Rulings EM-EO; completeParkedStep seam) into s1-storm.
Conflicts:
- jobs/handlers.ts: E1's makeSignedPdf with meta, plus S1's storm jobs.
- tasks/handlers.ts: E1's real sendProposalStep/orderExactReport plus S1's three handlers; doc comment updated.
- shared steps.ts: imports union, with TIERS/Tier.
- messaging/dispatcher.ts: S1's scheduled-email dispatch kept; PARKED_TEXT_STEP_TYPES = send_sms_batch, send_proposal, send_email_batch with E1's typed settleParkedStep.
- web job/api.ts: imports union.
Then 33cbb86 drops a duplicate StepRow import in send-batch.ts. Local: typecheck/lint/lint:css clean, shared/send-gate 1193, web 915, drizzle-kit no changes, playwright --list 43 tests, playwright-core only 1.56.1.
T28 launched from 33cbb86 (wf_6a01c1f2, contact 235, sonnet).
Sentinel pass 9 (11:22Z; probe green 38239319966 with T11): (1) At the a1-agents merge, isAgentPaused is the first thing inside the drafting transaction and returns null when paused (no task, no alert). draftStormPlan returns { taskId } | null (the job ignores it). POST /api/storms/:id/plan answers 409 'Storm Scout is paused. Turn it back on in Agents to draft a plan.' (copy confirmed by the S1 lead), and storm-plan.test draft() throws on null. (2) At the d1/g1 merges, OFF_STEP_TITLES (tasks/service.ts, Record<StepType,string>) gains front_desk_call, front_desk_texts, send_personal_texts, build_claim_packet, create_appointment, move_appointment. (3) A1's rerunTask copies only { type, payload }, so an expired storm plan with off steps fails with a 400 and re-enables off steps. S1's answer: storm plans are re-drafted through draftStormPlan, never rerun. This goes with the whole-branch review fix that lets draftStormPlan replace expired/declined plans; A1 should send storm_plan tasks to the storms redraft route rather than rerunTask.
Ruling BC (controller, 11:22Z): the draftStormPlan pause design is approved: returns { taskId } | null (null when paused: no task, no alert); POST /api/storms/:id/plan answers 409 "Storm Scout is paused. Turn it back on in Agents to draft a plan."; A1 implements it at its s1 merge, and if S1 touches draftStormPlan first (the whole-branch review redraft fix) it adopts the same signature. OFF_STEP_TITLES gains D1/G1 step types at the S1 d1/g1 merges. Storm-plan reruns re-draft through draftStormPlan (A1 implements).
s1-storm (T19 + c1-crm/e1-estimator merge, code at 33cbb86): ci-check 38240818004 PASSED (Platform, Hail, E2E). S1 build tasks T1-T27 and T29 are all merged and green. Open: T28 (wf_6a01c1f2), I5 (C1 lead), then the whole-branch review.
WHOLE-BRANCH REVIEW (three read-only reviewers on 8824456).
- Pipeline/hail: 1 critical (yesterday's storms re-created as today's because MESH_Max_1440min is a rolling 24-hour max), 5 important (double or missed final run; merged/split storms double-text; re-draft can overwrite an approved plan; expired/declined plans can't be re-drafted; {day} frozen at draft time), 9 minor.
- Money/consent/tenancy: 6 important (lost enable leaves a campaign unguarded; one Check error turns off the 95% guard; Meta ad sets created PAUSED never deliver; YES attaches to an unsent storm text; a storm text can be relabelled informational; ad max can be raised server-side), 3 minor.
- Web: 1 critical (map layer sends a fractional zoom, so the API 400s), 2 important (no link to My routes; ad account reasons never shown), 7 minor.
Fix tasks:
- R1 (hail: 60min MESH accumulated into the day, one explicit final 12Z run, merged_into column; Ruling AW: column added to 0018 + snapshot), R2a (plans/locks/re-draft + Ruling BC signature), R2b (consent/messaging) run in wf_cabe1d1b (contact 237, sonnet), from 2c5c984 (R1 from b0d568d = + 60min fixtures and an eccodes oracle captured by the lead).
- R3 (ad spend) goes to the C1 lead after I5.
- R4 (web) launches when T28 finishes.
Briefs: ops/sdd/s1/task-{r1,r2a,r2b,r3,r4}-brief.md. Accepted deviation: the default ad split is 55% ($148.50/$121.50 on $270); the spec's $150/$120 needs 55.56%, which an integer percent can't express.
I5 (C1 lead): c3c6fe0 (+ report commit 10d066a). The storm page's active_until is extended to the campaign end + 1 day (extendStormPageUntil, extend-only, tenant-scoped). No POLICY_PAGES_DOMAIN: needs attention before any claim or platform call (the PUBLIC_BASE_URL fallback is removed). The smoke renders the real card. AD_ERROR_COPY stays in the API with a keep-in-sync comment (vendor names; the API can't import web copy). CI 38243119651 Platform/E2E/Hail/v1 green (after one fix for a 60-day test campaign). Merged into s1-storm; local typecheck/lint clean, drizzle-kit reports no changes. R3 (C1 lead) is now stacked on c3c6fe0.
Sentinel pass 10 (12:04Z; probe green 38244113600): A1 carries the pause check (draftStormPlan returns null). The route 409 and the expired/declined re-draft are both in R2a (running). G1/D1 OFF_STEP_TITLES at those merges. When R1 lands its 0018 change, the other tracks rebuild their snapshots after 0018.
s1-storm with I5: ci-check 38245555894 PASSED (Platform, Hail, E2E).
R3 (C1 lead; stacked on I5): b2b600b (577674c main, 2e38104 test fixes). Fixes:
- Lost enable: after the external id is stored, any throw makes a best-effort pause. The sync also sweeps failed rows and stale creating rows that have an external id, and pauses any the platform reports live. The fakes gained loseResponseOnNextSetStatus.
- A thrown Check keeps the previous account status (only lastErrorPlain changes). syncOne runs for any non-revoked account.
- Meta ad set and ad are created ACTIVE, with the campaign PAUSED as the one switch.
- New ad_campaigns.paused_by ('roofline'|'platform'): a platform pause keeps being synced, and only our 95% pause, ended, or a confirmed-off sweep stops it.
- USD-only accounts (NOT_USD before the claim).
Ruling AW: 0018 amended in place (paused_by + CHECK; app_system SELECT on paused_by and updated_at) plus 0018_snapshot.json; drizzle-kit reports no changes. CI 38248652411 Platform/E2E/Hail/v1. Merged into s1-storm; local typecheck/lint clean, 668 shared tests, drizzle-kit no changes. Note: a deliberate step retry on a failed row re-enables it and clears paused_by (owner-initiated, acceptable).
T28: CI rounds 1-3 failed E2E. Fixes so far: the company storm id, the map a11y role, row matching. Remaining cause: the send gate holds storm texts/emails in quiet hours when CI runs before 08:00 Chicago. 0909fb5 (seed a mid-day company zone) is on CI now.
Ruling BD (controller, 12:56Z): A1 owns the storm re-draft mechanism (lockStormPlan, supersedeDraft, REDRAFTABLE widened to draft/expired/declined). S1 drops R2a's replaceDraftPlan re-draft and locking work. S1 keeps: draftStormPlan -> { taskId } | null with the pause check first; the POST /api/storms/:id/plan 409 paused copy on null; and the consent fixes (R2b). R2a was already running in wf_cabe1d1b with R1/R2b (stopping it would stop them), so at merge the lead keeps only the BD-allowed parts plus non-overlapping minors, and reverts replaceDraftPlan/lock/REDRAFTABLE changes. R1 (storms.merged_into) lands as soon as it is green; A1, G1, D1 and the probe rebuild their post-0018 snapshots after it.
s1-storm with R3: ci-check 38251534932 PASSED (Platform, Hail, E2E). T28 on 0909fb5 (run 38250663843): 49/52 e2e pass, including storm plan in 2 clicks. Three remain (route view a11y, landing form post not redirecting on the phone, phone /storm heading); a focused agent is fixing them on s1-t28.
Ruling BD amended (controller, 13:15Z): storm-match and automatic drafting re-draft only over draft plans. Expired/declined plans are replaced only by an explicit rerun (A1 allowFinished). R2a handling unchanged (keep the null signature, the 409, and non-overlapping minors).
T28 (wf_6a01c1f2 + a focused fix agent): e89fa35. Adds storm.spec (storm plan in 2 clicks: all five steps Done with the fakes; office approves messages, owner approves spend), doors.spec (rep marks "Wants a check" and the lead reaches the rep's Today; the landing page on a phone submits a request), a11y and phone no-scroll for /storm, /storm/:id, the route view and the landing page, seedStormFixture (exported from @roofline/api), docs/superpowers/s1-acceptance.md and README env docs.
Product bugs the e2e found and fixed:
- (1) helmet's default Referrer-Policy no-referrer made browsers send Origin: null on the landing form POST, so the Origin guard refused EVERY homeowner request. The storm page now sends Referrer-Policy: same-origin, with an api test.
- (2) RouteMap was role=img around focusable MapLibre links; it is now role=region.
Test-side: e2e company zone set to a mid-day zone (9-19 local, every UTC hour covered, with a test) so quiet hours don't hold the storm texts/emails; the phone spec waits for the list region. CI 38254137473 Platform/E2E/Hail/v1 green (52 e2e tests). Merged into s1-storm.
R4 (wf_6d1b30d1, contact 239): c2e0827 (bad1059 + tokens.ts mirror fix). Storm layer zoom rounded and clamped; My routes link in StormWindow and the phone More sheet; ad accounts show lastErrorPlain (the dead reason copy is gone); plan statuses cover all TASK_STATUSES; a loading skeleton; count-free stat labels; decimal input for the ad max; RouteMap dot effect split; marker shadow tokens. CI 38254351772 Platform/E2E/Hail. Merged after T28 (one test conflict: count-free labels plus T28 map role=region). Local: typecheck/lint/lint:css clean, web+ui 1115 tests, e2e list 52. Note: the Redraft button shows for expired/declined plans; on s1-storm the API still answers 409 for those until A1 widens REDRAFTABLE (Ruling BD).
Ruling BE (controller 13:41Z, launch runbook 1.10): (1) unify on POSTMARK_TOKEN (hail main.py reads POSTMARK_SERVER_TOKEN; keep it as a fallback); (2) document OPS_ALERT_EMAIL (it must be a verified Postmark sender) in the config schema and .env.example; (3) hail-health 180/720 minutes come from config; (4) POLICY_PAGES_DOMAIN required: already done in I5. Items 1-3 are task R6 (brief task-r6-brief.md), after R1 and R2b merge (they edit main.py and hail-health.ts).
Review fixes wave (wf_cabe1d1b, contact 237, sonnet):
- R1 e0812a1: the hail day is built from MESH_Max_60min grids accumulated by union; one explicit final per day from the 12:00:00Z 1440min key, with old unfinalized days closed later; storms.merged_into (0018 + snapshot, Ruling AW; app_hail UPDATE(merged_into)); the oldest id survives a merge; in-memory failure counting; matching/layer/fan-out filters. CI 38250896980 on 6d503ab.
- R2a 0edd7ae: draftStormPlan -> { taskId } | null with the A1 marker first; the route answers 409 PLAN_PAUSED on null; plan-errors.ts constants; storm-draft drops permanent failures; ?since= (default 30 days); no second ready email for a re-draft of a draft. CI 38254123531 on aa9f2af.
- R2b 3ab6e88: YES only to sent/delivered storm texts; editStep keeps storm steps marketing with the same dedupe, and the ad max/days can't rise; the SMS {day} label is computed at send time; a scheduled email to a changed address is blocked; replies counted within 14 days; the now-alert claim is released on total failure and alertUnalerted added; hail-health alerts every tick past the threshold with a cooldown; the 0018 email_opt_outs SELECT(email) is kept with a reason comment (ON CONFLICT needs it). CI 38249000689 on 705a479.
Merged R1, R2a, R2b (no conflicts). Then the Ruling BD trim: replaceDraftPlan restored to its T11 form, R2a's storm-plans db test dropped, REDRAFTABLE_PLAN_STATUSES = ['draft'], and the tests list expired/declined as "left alone". A1 widens these at its s1 merge. Local: typecheck/lint clean, shared/send-gate 1193, web 945, drizzle-kit no changes, Python parses.
Remaining group-check items go to R7 (brief task-r7-brief.md, which also folds in R6/Ruling BE):
- merged_into filters in storm-api.ts and storm-alerts.ts;
- afterMatch calls alertUnalerted;
- listUnalertedMatched bounded to 3 days;
- R1 hail minors.
Note: PLAN_PAUSED cannot be reached until A1 T14 wires isAgentPaused into plan.ts.
R5 (C1 lead): 0d1c8d4 (5e75615 code). One landing code rule (STORM_PAGE_CODE_RE in repos/storm-pages.ts, used by both public routes). The rate limit and Origin guard moved inside stormRequestRoutes, so form posts get ?error=busy/invalid while JSON keeps its status codes. createStormRequest goes through createJob (audit and timeline lines; actor system). doors placeFor is synchronous with named fallbacks. When a landing request matches another customer's home, the job line says "sent for this home by <name>". CI 38255682720 Platform/E2E/Hail/v1. Merged into s1-storm (auto-merged storm-page.ts; T28's Referrer-Policy fix kept). Local: typecheck/lint clean, 668 shared, e2e list 52. Behaviour: a malformed code with a browser Origin gets 403 from the guard.

## Ruling BF (controller, 2026-10-12): security review fixes before S1 completes
Source: `ops/sdd/integration/security-review.md` on `origin/sec-review` (probe launch-integration a7e2b559). S1 owns:
- **High 1:** ad accounts shared across companies. **R8:** a global partial unique index in 0018 (Ruling AW); claim the row before calling the platform; unlink only when this company was the live holder.
- **High 2:** `Referrer-Policy: no-referrer` turns Origin into null on the public forms. **R9:** the unsubscribe confirm page uses same-origin; e2e specs submit both forms.
- **Medium 3:** unverified SMS consent from the storm form. **R10:** the form never writes or upgrades consent; a YES from that phone within 14 days makes it express; per-IP share and per-phone caps.
- **Lows 9, 10, 14, 18:** **R8** trims the 0018 grants; **R9** keeps `/u/` tokens out of logs and limits the S1 public routes.

The three tasks run in parallel from 83e9856, with Sonnet builders, and need CI on Platform, E2E and Hail before each merge. Finding 4 (`TRUST_PROXY`, F2/F3) limits how effective the per-IP caps are; it is not S1's.

## 2026-10-12: E2E red on 83e9856 (run 38259582760) and fix 3f800e5
- Platform and Hail passed. E2E had 7 storm specs fail, all with `create_ad_campaign: needs_attention` and the `NOT_USD` message.
- Cause: R3 (577674c) made the ad campaign step refuse an account whose currency isn't USD. `scripts/storm-fixture.ts` inserted ad accounts with a null currency.
- Fix 3f800e5: fixture accounts now have currency USD and a name, plus external ids per company (derived from the company id), so they stay valid under R8's global unique index.
- R7–R10 branch from bases before 3f800e5, so their E2E shows the same 7 failures. Those are the base's failures: judge each task's E2E on the merge result after it lands on s1-storm.

## R7 merged (s1-r7 0c2717a, merge on s1-storm)
- R7 run 38259664396: Platform and Hail passed. E2E had the same 7 failures as the base (the NOT_USD fixture, fixed in 3f800e5). E2E is judged on the merged head.
- Merged locally: typecheck, lint, shared tests (668) and drizzle-kit "No schema changes" all pass.
- Decision recorded: a merged storm stays hidden from lists until it has a plan. Alerts and settle candidates always skip merged storms, so a merged storm with a draft plan is not re-drafted.
- Ruling BE config:
  - `HAIL_ALERT_STALE_MINUTES_SEASON` = 180;
  - `HAIL_ALERT_STALE_MINUTES_OFFSEASON` = 720;
  - `POSTMARK_TOKEN` in the hail service, with the deprecated `POSTMARK_SERVER_TOKEN` as fallback.

## Carries from the integration sentinel, pass 12 (session_01RypesnL2fbawyJH5HtdS7E)
For the next e1-estimator merge into s1-storm:
- Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET to the production `VALID` config in `apps/api/test/storm-config.test.ts`, `google-ads-http.test.ts` and `postmark-broadcast.test.ts` (E1 Ruling ET).
- Add E1's `proposalListRoutes()` stub to the s1-routes test "dock Storm opens /storm".

Already done: s1-r2a is merged (28f3800) with the Ruling BD trim (41b970c). REDRAFTABLE_PLAN_STATUSES is `['draft']`, and replaceDraftPlan is restored to T11's version.
- Carry for the a1-agents merge (controller, Ruling BD detail): delete REDRAFTABLE_PLAN_STATUSES from `apps/api/src/storm/plan-errors.ts`. Its callers import A1's db exports REDRAFTABLE_PLAN_STATUSES (['draft']) and FINISHED_REDRAFTABLE_PLAN_STATUSES (['expired','declined']).
- CI run 38263313497 on s1-storm@c2e3a1f (R7 merge plus the 3f800e5 fixture fix): Platform, Hail and E2E all green.
- b46f1f5: `apps/api/test/helpers.ts` builds `FakeExactReports(() => clock.now())`. This defuses the E1 time bomb: exact-report.test.ts pins 2026-10-12T15:00Z, so it has been red everywhere since 15:01Z (the controller's request). R8–R10 branch from before this fix, so their Platform job may show the exact-report failure; it is the base's, so judge it on the merged head.
- CI run 38270389296 on s1-storm@7159e1c (after the time bomb fix): Platform, Hail and E2E all green.

## Re-merge of c1-crm 7758e82 and e1-estimator 414b97b requested (E1 lead for the controller, Ruling BF)
Order: R8–R10 first, so 0018 is narrowed and errors.ts carries the pathForLog change. Then merge c1-crm and e1-estimator. Keep both sides in `config.ts`, `rls.test.ts` and the production config fixtures. Changes that come with the merge:
- Production configs need `TRUST_PROXY: '1'` and the R2 keys.
- The session cookie names come from the constants in `sessions.ts`.
- `loginRateLimit()` and `inviteRateLimit()` return arrays, which the routes spread.
- app_system privileges are exact: no TRUNCATE, TRIGGER or REFERENCES. Tests write through the owner client where app_system lacks a grant.
- The errors.ts late-error branch uses `pathForLog(req.path)`.
- Sentinel carries: the R2 keys in the storm-config, google-ads-http and postmark-broadcast production VALID configs, and the `proposalListRoutes()` stub in s1-routes.

## R8, R10 and R9 merged (Ruling BF): 2ce5f97, ed89f75, 3097bec
**R8** (s1-r8 0f67728): an external ad account links to one company only.
- Changes:
  - a global partial unique index on (platform, external_account_id) where not revoked, in 0018 (Ruling AW);
  - the connect claims the row first, so a conflict is a 409 with no provider call;
  - unlink runs only for the live holder;
  - 0018 grants narrowed;
  - recordEmailOptOut now uses `on conflict do nothing` with no target (app_system no longer reads email_opt_outs.email).
- CI: Platform was red only on the exact-report time bomb; E2E was red on a base that predates 3f800e5.
- A pending row left behind by a crash between claim and settle keeps the account locked until the owner deletes it. This is accepted.

**R10** (s1-r10 e4b61bf):
- The form never writes or upgrades consent.
- A Twilio-signed YES from that phone within 14 days makes consent express, with evidence.
- Each IP is capped at 2 requests per page per hour; each phone at 1 per page per day.
- CI on 1af8535: Platform and Hail passed; E2E was red on the old base.

**R9** (s1-r9 012df2a):
- The unsubscribe confirm page uses `Referrer-Policy: same-origin`.
- Origin: null is refused, with tests.
- The e2e spec `public-forms.spec.ts` submits both forms.
- pathForLog scrubs `/u/:token`.
- Limiters on the storm page, the policy pages, `/u` and `/hooks/postmark`; Postmark lets a 429 through.
- CI on d42402d: Platform and Hail passed; E2E had 53 of 54 passing, the only failure being an a11y login "socket hang up", while 905266e passed E2E with the same specs. Judge it on the merged head.

Merged locally: typecheck, lint, shared tests (668) and drizzle-kit "No schema changes" all pass.
- CI run 38275152764 on s1-storm@07fa559 (R8–R10 merged): Platform, Hail and E2E all green.

## c1-crm 7758e82 and e1-estimator 414b97b re-merged (Ruling BF / SEC-1..4 / EU)
- Merged in the s1-sec worktree and fast-forwarded into s1-storm.
- Conflicts:
  - config.ts: S1's ad checks kept, plus C1's TRUST_PROXY check and E1's R2-in-production check;
  - rls.test.ts: S1 and E1 grant tests and C1's no TRUNCATE/TRIGGER/REFERENCES test, all kept;
  - the worker schedules, jobs.test and pgboss.test: S1's four schedules plus E1's signed-pdf-sweep;
  - system/index.ts, the package.json smoke scripts and STORED_FILE_KINDS (S1's kinds kept);
  - the e2e fixtures (seedFootprintFixture runs before the storm fixture);
  - the a11y and phone spec imports.
- e726ecf:
  - TRUST_PROXY and the R2 keys in the production configs of the storm-config, postmark-broadcast and google-ads-http tests;
  - `pathForLog` in the errors.ts late-error branch;
  - `proposalListRoutes()` in the s1-routes dock test.
- R8 had already narrowed 0018, so C1's app_system test holds.
- Local checks: typecheck and lint pass; web 970 and shared/ui/send-gate 1367 tests pass; drizzle-kit reports no changes.

## Sentinel pass 13 and the controller's final Ruling BD (16:41Z)
- **Redraft button:** POST /api/storms/:id/plan from the "Draft a new plan" button is an explicit owner action and passes allowFinished, as the rerun route does; automatic paths never do. A1 wires this in a1-merge-up2. The button therefore stays on expired and declined plans. Branch s1-r11 (56f534a, which hid it) is NOT merged.
- **spotter_reports grant:** already fixed by R8. app_system has SELECT and INSERT only, with no GRANT ALL in 0018.
- **TRUST_PROXY and R2 in the production fixtures:** done in e726ecf.
- **updated_at hazard (controller):** 0018 has two column-level UPDATE grants:
  - app_system `UPDATE (place_name) ON storms`;
  - app_hail `UPDATE (merged_into) ON storms`, which is redundant beside app_hail's table-wide UPDATE on storms.
  `storms.updated_at` is a plain `tstz(...).defaultNow()` without the `timestamps()` helper's `$onUpdate`, so Drizzle adds no updated_at to those updates. No code path updates storms.place_name as app_system: the only writer is the e2e fixture, through the owner. No grant is affected, so nothing changes.

## S1 COMPLETE (2026-10-12)
- s1-storm@7ad99c9 (code head) passed CI run 38277874294 on Platform, Hail and E2E.
- Included: Tasks 1–29, the whole-branch review fixes R1–R7, the Ruling BF security fixes R8–R10, and the c1-crm 7758e82 and e1-estimator 414b97b security re-merges.
- AGENTS.md "Where things stand" is updated.
- s1-r11 is not merged (final Ruling BD).
- Carries for later merges are listed above:
  - **a1-agents:** take A1's StepTypeDef, re-draft code and redraftable-status exports; allowFinished on the "Draft a new plan" POST; fresh: !previousWasDraft.
  - **d1 / g1:** OFF_STEP_TITLES entries.
- Owner to-dos:
  - test accounts for Google Ads and Meta;
  - a Postmark broadcast stream and its webhook secret;
  - a Render worker for services/hail, with HAIL_DB_PASSWORD, POSTMARK_TOKEN, and OPS_ALERT_EMAIL set to a verified sender;
  - POLICY_PAGES_DOMAIN;
  - TRUST_PROXY=1 on the API and the worker;
  - the T29 manual smoke run (docs/superpowers/s1-manual-smoke.md).

## Launch dress rehearsal BUG-1 fixed (89ab4c4)
- The hail swath fill used a MapLibre `match` with decimal labels, which MapLibre refuses ("Numeric branch labels must be integer values").
- Effect: no swath was ever drawn, and the home map showed its loading error.
- Fix: `hailFillExpression()` is now a `step` on thresholdIn.
- Test: `apps/web/test/storm-layer-expression.test.ts` compiles the expression with `@maplibre/maplibre-gl-style-spec`, a transitive dependency of maplibre-gl, and checks each level's colour.
- Source: `ops/sdd/integration/dress-rehearsal.md` on ops-rehearsal.
- s1-storm@85a68e7 (the BUG-1 fix plus its test update): CI run 38288147079 is green on Platform, Hail and E2E.

## Demo UI lift 05: hail heat map look (branch `lift-05-hail`, from `demo-mode`)

- Swath fill opacity 0.45 to 0.7 (`HAIL_FILL_OPACITY`, also used by the storm detail map); the swath "outline" layer is now a wide, blurred line in each contour's own hail colour, which feathers the band edges into a heat gradient.
- Base map: MapTiler style `streets-v2` becomes `dataviz-light` (satellite `hybrid` unchanged); the OSM raster fallback is desaturated and lowered in contrast.
- Map legend (`HailLegend`) is a compact horizontal chip row titled "Last night's hail" (Penny, Quarter, Ping-pong, Golf ball, Tennis ball = levels 1-5; the inch size is the chip tooltip). New copy keys `hailLegendTitle` and `hailSizeNames`; `hailLegend` stays the accessible name and the storm detail legend is untouched.
- Not done: scored-home squares. The web app has no scored-homes data source yet (spotter reports are the only points), so nothing was invented.
