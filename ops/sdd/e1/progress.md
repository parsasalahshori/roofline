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
