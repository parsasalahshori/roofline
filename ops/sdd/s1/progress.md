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
