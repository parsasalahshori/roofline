# SDD ledger — plan: docs/superpowers/plans/2026-10-12-roofline-estimator.md

Spec: docs/superpowers/specs/2026-10-12-roofline-estimator-design.md. Branch `e1-estimator`, to be created from `c1-crm` once C1 is merged (C1 is not built yet; at writing `origin/f3-setup` is 7b988eb). Briefs: `ops/sdd/e1/task-<N>-brief.md`; constraints: `ops/sdd/e1/global-constraints.md`. Rulings use the prefix **E**. Names marked **[C1]** in briefs come from the C1 plan and briefs and must be checked against `c1-crm` before each task starts.

## C1 dependencies (check against the real code when C1 is merged)

| C1 task | Name E1 uses | E1 tasks |
|---|---|---|
| T1 | migrations end at `0013`; `pdfkit` + `@types/pdfkit` in `apps/api` | T1, T8, T13 |
| T5 | `JOB_NAMES` has `calendar-push`, `JobData.appointmentId`, `SCHEDULES` has `calendar-pull`; C1 mounts in `app.ts` | T5 |
| T6 | `createJob`/`updateJob` with stage rules and `StageRuleError` (lead/inspection → proposal; won needs a value) | T8, T11, T12 |
| T7 | server geocoding lives inside `routes/properties.ts` (no reusable function) | T7 (Ruling EB) |
| T12 | `SetupFacts.calendarsConnected` already added; `deriveSetup` edited | T8 |
| T15 | `getPricebook(tx, ctx) → PricebookView`, `DEFAULT_QUOTE_DEFAULTS` (`repos/pricebook.ts`) | T8 |
| T16 | `PDF_COLORS` (`apps/api/src/quotes/pdf.ts`) | T8 (Ruling EC) |
| T18 | routes in `router.tsx`, `DockApp.shipped: boolean` (Ruling CB), `prices` Settings tab | T14 |
| T20 | `features/job/JobSections.tsx` | T20 |
| T22 | `features/create/CustomerPicker.tsx` | T15 (import only) |
| T25 | `features/settings/PricesTab.tsx`; `features/setup/SetupRow.tsx` (connect_calendar action) | T14, T18 |
| T27 | `features/today/{Today.tsx,api.ts}` (`useToday`) | T20 |
| T28 | e2e specs and the appended phone/a11y lists | T21 |
| T29 | `smoke:calendar` layout | T22 |

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1↔F1 | `properties.footprint_id` is `text` (F1); `building_footprints.id` is `bigserial` | gap → Ruling EA |
| T1↔F1 | `company_settings.financing_apr_bps`/`financing_term_months` already exist | consistent (T1 adds only the five new columns) |
| T2/T3↔T4 | `Outline`, `InstantEstimate`, `AddOn` types while all three run in G1 | gap → stub until merge (T4 brief) — cost: none |
| T4↔F3 steps | preview shape and `stepTypes` registry | consistent |
| T5↔F3 | `isPublicRoute` is private in `auth/middleware.ts`; `readOnlyGuard` must pass `/api/public/` | consistent (T5 owns both edits) |
| T5↔F3 | step handlers are registered in `tasks/handlers.ts` (`builtInHandlers`), job handlers in `jobs/handlers.ts` | consistent (named in global constraints) |
| T6↔T7 | `footprintsNear` is a tenant read in T7's `repos/measurements.ts`; T6 exports only from `system/` | consistent |
| T7↔C1 T7 | `measureProperty` needs geocode-then-create; C1 has it only inside a route | gap → Ruling EB |
| T7↔T10 | both edit `routes/measurements.ts` | consistent (chained: T10 after T7) |
| T8↔C1 T16 | plan says "reuse C1's `PDF_COLORS` and table helpers"; C1 T16 exports `PDF_COLORS` and `renderQuotePdf` only | gap → Ruling EC |
| T8↔C1 T12/F3 T16 | `shared/setup.ts`, `repos/setup.ts` | consistent (T8 is E1's only editor) |
| T8↔T20 | Today "Signed today" needs data; C1's `TodayView` is C1's type | gap → Ruling ED |
| T8↔T10/T11/T12 | `repriceFromMeasurement`, `getProposal`, `renderProposalPdf` | consistent |
| T11↔F3 | `sendOneText` exported from `send-batch.ts`; the lease line stays first | consistent (carry) |
| T12↔T13 | `signed-pdf` job queued by `signProposal`, handled in T13 | consistent |
| T13↔F3 Mailer | plan says "email copy"; `Mailer` has no attachments | gap → Ruling EE |
| T14↔C1 T18/T25 | `router.tsx`, Settings slots, `PricesTab.tsx` | consistent (E1 T14 only) |
| T15–T20 self | plan task bodies omit Files lines | gap → Files added in each brief from the plan's file structure — cost: none |
| T18↔C1 T25 | `SetupRow.tsx` one more action | consistent |
| T20↔C1 T20/T27 | `JobSections.tsx`, `Today.tsx` | consistent (E1 T20 only) |
| T21↔C1 T28 | e2e base | consistent |

Ruling EA: `properties.footprint_id` stays `text` holding the stringified `building_footprints.id`, with no foreign key — the global footprint table can be reloaded per state and a tenant row must not block that — cost if wrong: a dangling id shows "outline not found" and re-measures.
Ruling EB: `measureProperty` (T7) geocodes with `deps.geocoder.geocode` and then calls F1's `createProperty`, instead of calling C1's route code — C1 T7 keeps geocoding inside `routes/properties.ts` — cost if wrong: two call sites of the geocoder (same rules).
Ruling EC: T8 imports only `PDF_COLORS` from C1's `quotes/pdf.ts` and writes its own table helpers in `proposals/pdf.ts`; C1's file is not edited — C1 T16 exports no table helpers — cost if wrong: a little duplicated layout code.
Ruling ED: `listProposals` (T8) accepts `signedOn?: string` (company-zone date), and T20's "Signed today" list calls `GET /api/proposals?status=signed&signedOn=<today>` instead of extending C1's `TodayView` — keeps C1's shared type untouched — cost if wrong: one extra request on Today.
Ruling EE: the signed-agreement email (T13) contains a link to `GET /api/public/proposals/:token/signed.pdf`, not an attachment; F3's `Mailer` (`{ to, subject, text }`) is unchanged — cost if wrong: the homeowner opens a link instead of an attachment.

## Waves (from the plan)

- W1: T1. W2: G1 = T2, T3, T4. W3: G2 = T5, T14.
- W4: G3 = T6, T8, T9 · G4 = T15, T16, T18 · G5 = T17, T19, T20.
- W5: G6 = T7, T11 · then G7 = T10, T12 · then T13.
- W6: T21; T22 by hand.

## Tasks

## Build log
Track lead session_01UtFnF1PL9Tbc2z44JfhQDM (started by controller session_01LXtxzoHNoWz5SACkLF1d2p). `e1-estimator` = c1-crm dfa9132 + e4dbe2f (briefs/constraints renumbered to 0015/0016 per Ruling AP).
Wave 1 (wf_c2f810c9-41c, contact 101): T1 on e1-t1, base e4dbe2f.
Wave 2 in parallel (wf_8c32dc49-5b4, contact 102): T2, T3, T4 on scratch commit 4f9bae5 (branch e1-scratch, on e4dbe2f) that writes T1's shared constants block in `shared/proposals.ts`, type-only stubs of T2's `LngLat/Ring/Outline/InstantEstimate` (`roof.ts`) and T3's `AddOn` (`tiers.ts`), and the three barrel lines.
Merge rule (T1 first): add/add conflicts → `roof.ts` takes T2, `tiers.ts` takes T3, `proposals.ts` = T1's constants block + T4's additions below it, `shared/index.ts` = T1's.
On T1 merge: send_message S1 session_01XaGX8pcLBpR2SWeGqsd3gP with the e1-estimator sha, copy controller.
CI outage (controller, 02:21Z): GitHub Actions down (billing). No merges into e1-estimator until CI passes. Waves 1-2 started before the notice, so their ci-check calls fail; any commit made only to chase that failure is reviewed and reverted before merge. When CI returns: ci-check each waiting task branch, then merge.
Task 1 (wf_c2f810c9-41c, contact 101): 78756e6, review clean, CI 38194636634 green (Platform incl. DB suites, E2E; ran 02:08-02:23Z, before the outage). Lead review: 0016 grants/RLS match the brief; `drizzle-kit generate` reports no changes. Extra (kept): `GRANT USAGE, SELECT ON SEQUENCE building_footprints_id_seq TO app_system` (bigserial inserts by the loader); db-only `TIER_MATERIALS` in `schema/enums.ts`; company_settings new columns rely on 0002's table-wide tenant grants. Task 1: complete. Merged into e1-estimator c0ac821 (typecheck, lint clean; playwright-core 1.56.1 only).
Wave 2 (wf_8c32dc49-5b4, contact 102), base scratch 4f9bae5:
- T2 4faa753: review clean, CI 38194659737 green. `offsetOutline` (in the brief's Split but not its Interfaces) not built; geometry in `roof-geometry.ts`, re-exported by `roof.ts`. Task 2: complete.
- T3 8c35f6b: review clean, CI 38194921319 green. Judgement: spec Decision 10's "highlights +" would give Better 5 highlights over the cap of 4; Better drops "Tear-off and cleanup". `monthlyPaymentCents` throws RangeError on a non-finite principal. Task 3: complete.
- T4 a96d7be: review clean, local verify clean; CI 38195634306 cancelled by the outage, re-run (same run id) green. Task 4: complete.
Merged into e1-estimator: T2 387349a (roof.ts from T2; proposals/tiers/index from T1), T3 6fc70ba (tiers.ts from T3), origin/c1-crm 0a7c943 (C1 T18), T4 (clean). shared 454 tests, web copy-rules, typecheck, lint clean; playwright-core 1.56.1 only.
Carries: send_proposal preview labels totals Good/Better/Best by position only when 3 totals: T8/T11 always send 3 totals in tier order, or extend the payload to {tier,totalCents} (group check 102). pitchFactor/geometry minors in task-2-report.md.
Wave 3 (wf_52209e53-04e, contact 103, builders Sonnet per Ruling AQ): T5 on e1-t5 from e1-w3base 2504960 (= e1-estimator 278a478 + merge of origin/c1-t5 46e54e3, C1 T5 whose CI has not passed yet); T14 on e1-t14 from 278a478.
Merge rule: e1-t5 is merged into e1-estimator only after C1 T5 is CI-green (ideally after c1-crm carries it and is merged into e1-estimator first); C1 T25 later rewrites PricesTab.tsx: keep C1's body and E1 T14's three section slots.
Merged origin/c1-crm 0fe2b16 (C1 T5 CI 38195617057; F3 T28, T37) into e1-estimator: typecheck, lint clean; drizzle-kit no changes.
Ruling EF (controller, accepted): tier highlights capped at 4 (Better drops "Tear-off and cleanup"; spec D10's "highlights +" would exceed the cap).
Ruling EG (controller, accepted): `offsetOutline` (named only in the T2 brief's Split, not its Interfaces) is not built; the edge allowance `perimeter + 8 × overhang` stands.
Wave 3 (wf_52209e53-04e, contact 103):
- T5 ae3d065: review round 1 fixed, CI 38197904378 green. Lead check: `isPublicRoute` adds only a lowercased `/public/` prefix (req.path is not percent-decoded; `/public`, `/publicx` stay gated); readOnlyGuard exempts `/public/`. Task 5: complete.
- T14 20e2a6b: review clean, CI 38197723747 green (web 435). Task 14: complete.
Merged into e1-estimator: T5 b802c80 (brings e1-w3base 2504960, which changes no files: C1 T5 was already in via c1-crm), T14 7817449. typecheck, lint, lint:css, web 435 clean.
Carries: (T12/T19) blockCrossSiteMutations refuses mutations whose Origin is not APP_ORIGIN, so PROPOSAL_LINK_BASE_URL must be the same origin as APP_ORIGIN, or /api/public mutations must allow it (group check 103). (T6) FakeFootprintSource reads its fixture with readFileSync at module load from test/fixtures; make it lazy. Stub eslint-disable lines go when real bodies land.
Merged origin/c1-crm 36a8cc5 (F3 closed) into e1-estimator fcaced6: typecheck, lint clean; drizzle-kit no changes.
Wave 4a, base fcaced6 (C1 names not needed): run wf_9f1f57c2-275 (contact 104): T6 (Sonnet builders), T9, T19; run wf_569594ab-55b (contact 105): T16 (Sonnet), T17 (Sonnet), T18.
Held for C1: T8 (C1 T6 createJob/updateJob, T12 SetupFacts.calendarsConnected, T15 getPricebook, T16 PDF_COLORS), and T20 (C1 T20 JobSections, T27 Today). T15 (CustomerPicker from C1 T22, optional import) and T7 (needs T6) go in the next run; T10-T13 follow T8.
Sentinel (sibling 3, 03:40Z): A1 changes StepTypeDef (withMinutesSaved({userCreatable, baseline, units}) replaces minutesSaved); A1 converts E1's send_proposal and order_exact_report when it merges e1-estimator. New E1 step types keep the plain shape until then.
Ruling AY (controller, 03:41Z, supersedes the sentinel note above): A1 T3's StepTypeDef = plain object {userCreatable, baseline(), units()}, no minutesSaved; A1 converts E1's two step types at its merge. Any NEW E1 step type uses that shape from the start (userCreatable true, baseline 'proposal_sent' or 'exact_report', units 1). No remaining E1 task adds a step type (T10/T11 register handlers for T4's two types only).
- T17 (e1-t17): the PDF endpoint (T8) must answer with Content-Disposition: attachment so the proposal window download link (Button href, no download attribute) downloads the file.
Wave 4a results:
- T6 cecee73 (run wf_9f1f57c2-275, contact 104): review round 1 (one finding parked: the flake the lead described cannot happen, api vitest has fileParallelism false); CI 38201914643 failed (ST_MakeValid turned a bow-tie into a MultiPolygon before the type filter), fixed with ST_CollectionExtract + single-member check, CI 38202803240 green. Boundary decision: `apps/api/src/estimator/footprints-load.ts` added to DB_SYSTEM_ALLOWED (eslint.config.js) — the loader writes the global table as app_system. Fake fixture now lazy (T5 carry done). Task 6: complete.
- T9 e1a52a3: review clean, CI 38200640806 green. Lead follow-up e34b2f8: an unreadable report cost is `costCents: null` (was a silent 0), `ExactReports.report` type widened; onboarding note on the production auth flavor in http.ts (brief asked for it). CI 38203758724 green. Task 9: complete. Merged into e1-estimator. Open for T10/T22: order payload shape, DELIVERY_PRODUCT_ID 8, MeasurementInstructionType 1 follow v1 and need confirming at onboarding; PlaceOrder 204 = uncertain.
- T19 1d6a48d: review clean, CI 38200594307 green. Task 19: complete. Follow-up f011545 dropped the dead `homeowner.comingSoon`.
- T16 a6c270e (run wf_569594ab-55b, contact 105): review round 1, CI 38201086467 green. Task 16: complete.
- T17 e4f67d2: review clean, CI 38202469333 green. Task 17: complete.
- T18 3bdbcda: review clean, CI 38201148990 green. Task 18: complete.
Merged into e1-estimator: T6, T19 (f011545 incl. the copy cleanup), origin/c1-crm 3eb085d (C1 T6?-T12, T15, T17, T19, T22, T23; Ruling CF's 0014 text), T16, T17 (e1-routes.test: both placeholder rows dropped, both window tests kept), T18 (unused `tiers` import dropped) => 448add8. web 586 tests, typecheck, lint, lint:css, build:web clean; drizzle-kit no changes.
Ruling EH (lead): one MeasurementView — the shared one (T4) is canonical, extended with `overhangFt: number`, `center: LngLat`, and `ring: Ring` on each structure; pitch and valley stay in `estimate`; structures keyed by `footprintId`. T16's local copy is replaced. T7 answers exactly this shape (GET/PATCH return a full MeasurementView; PATCH `includedStructures` = footprint ids). Applied in fix-up branch e1-fx1 (with: Settings tier editor uses the proposal wording and shared `materialNames`; `EstimatorSettings`/`EstimatorSettingsPatch` move to @roofline/shared for T8).
Carries for T7/T8/T11 (group check 105): POST /api/proposals {measurementId} answers a ProposalView (web reads `.id`); exact-report POST answers 201 {taskId} and the measure window links /approvals/<taskId>; 409 = measurement locked; PATCH /api/proposals/:id with options keyed by id, plus send, link, revise, pdf (PDF answers Content-Disposition: attachment); GET/PUT /api/tier-templates body {templates} with field errors `templates.N.x`; GET/PUT /api/estimator/settings = EstimatorSettings.
Wave 4b: T15 (wf_796d146b-00a, contact 106, Sonnet builders) from 448add8. T7 starts after e1-fx1 merges (needs Ruling EH's type).
Fix-up e1-fx1 6fbd335 (Ruling EH applied; Settings uses proposals copy and shared materialNames, 'Unit' label is now 'Charged'; EstimatorSettings(+Patch) in @roofline/shared): CI 38204490365 green. Merged into e1-estimator.
Lead slip (recorded): e1-fx1 was merged after ci-check passed, but ci-check judges only the Platform job by default; its E2E failed (run 38204490365). Cause: c1-crm 3eb085d is red (CI 38201748327) on apps/web/e2e/setup.spec.ts (expects 4 "Coming with", 3 since C1 T12 made the calendar step real) and on apps/api/test/isolation.test.ts:304 (step order; passed on e1-fx1's Platform, looks order-dependent; C1/F code). Port a3991a9: setup.spec expects 3 (calendar line dropped); C1 told via the controller. Rule from now: before every merge check ALL jobs of the run (or run ci-check with CI_JOBS="Platform E2E"); T8 later moves setup.spec to 2.
T7 (wf_e5a5056c-645, contact 107) from a3991a9, ci-check with CI_JOBS="Platform E2E".
Sentinel pass 2 (05:00Z): conversion details if E1 ever merges a1-agents (Ruling AY says A1 converts at its merge): send_proposal/order_exact_report → plain StepTypeDef, baselines 'proposal_sent'/'exact_report', units () => 1; packages/shared/test/steps-e1.test.ts uses stepMinutes(def, p, result).minutes. setup.spec 'Coming with' count must track setup items (T8: prices_and_tiers → 2).
T15 721ae6e (wf_796d146b-00a, contact 106): review round 1 (F1 rejected: Button/Pressable already sets type=button; F2 amended; F3 fixed), CI 38205018808 Platform green, E2E red only on the inherited setup.spec. Lead follow-up on e1-t15: merged e1-estimator in (Ruling EH + setup.spec port), 478e9e0 = estimator.test fixture on the shared MeasurementView (group check critical: typecheck-only break), a saved home with no customer now shows the new-customer form and sends it, Estimate tag is a span (was a focusable no-op Pill), dead copy dropped. web 598, typecheck, lint, lint:css, build clean; CI 38206738876 green (Platform and E2E). Task 15: complete. Merged into e1-estimator.
Ruling EI (lead): draw mode must not lose the new customer or the click budget. When POST /api/measurements answers drawMode, MakeProposal passes the target and customer to /estimator/measure/:id in router state; the measure window's Make proposal then uses estimator/api.ts useBuildProposal + useSendProposal (customer from state when present) and ends on /approvals/<taskId>; T16's useMakeProposal goes. Done as a follow-up after T8 lands (T8 defines the build body) — cost if wrong: one extra click for drawn roofs.
