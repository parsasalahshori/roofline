# SDD ledger — plan: docs/superpowers/plans/2026-10-12-roofline-core-crm.md

Spec: docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md. Branch `c1-crm`, to be created from `f3-setup` once F3 is complete (at writing, `origin/f3-setup` is 7b988eb: F3 T1–T13 and T23 merged; T14–T22 and T24 open on their branches; T25–T37 not started). Briefs: `ops/sdd/c1/task-<N>-brief.md`; constraints: `ops/sdd/c1/global-constraints.md`. C1 rulings use the prefix **C** (CA, CB, …) so they never collide with F2/F3 letters.

## F3 tasks C1 assumes are merged

| F3 task | What C1 uses | C1 tasks |
|---|---|---|
| T9 (merged) | API skeleton: provider-factory pattern, `account/`/`public/` import rule, `JobQueue`/`InlineJobs`, `SCHEDULES` | T5 |
| T14 | Geocodio geocoder, `FakeGeocoder.failNext` | T7, T22 |
| T16 | `setupFacts`, `GET /api/setup`, `apps/api/test/setup.test.ts` | T12 |
| T21 | read-only mode (`readOnlyGuard` lets GETs through), company status on the session | T17 |
| T29 | kit `Checkbox`, `Banner`, `ProgressRing` | T22, T24, T25 |
| T30 | web skeleton: `Settings.tsx` (`subpage`), `tabs.ts` (`LaterTabKey = 'connections'`), `features/setup/*` | T18, T25 |
| T32 | `features/setup/SetupRow.tsx`, `SetupTab` | T25 |
| T36 | F2 T13/T18 e2e merged in (`fixtures.ts`: `loginAs`, `clicks`, `markTodaySeen`; `phone.spec.ts`, `a11y.spec.ts`) | T28 |
| T37 | smoke `assertConfirmed(argv, flag)` pattern | T29 |

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1↔all | migrations 0013/0014; F3 ends at 0012 (P3a) and adds no more (Ruling AO) | consistent |
| T1↔T5 | placeholders `repos/{appointments,quotes}.ts` (T1) get T5's three placeholder functions (Ruling 4) | consistent |
| T1↔T13/T14 | separate `calendar-links.ts` / `calendar-busy.ts` placeholders | consistent |
| T2/T3↔T4 | `BoardStage`, `WorkHours` imported by `crm.ts` while all three run in G1 | gap → note in T4 brief (stub until merge) — cost: none |
| T4↔T6–T9, T12, T15, T19–T27 | `crm.ts` view types | consistent |
| T5↔T6/T7 | `listAppointmentsForJob`, `listAppointmentsForCustomer`, `listQuoteSummaries` signatures | consistent (Ruling 4) |
| T5↔T8/T15 | bodies replaced, signatures kept | consistent |
| T5↔config | plan says add `GOOGLE_CLIENT_SECRET` "requires `GOOGLE_CLIENT_ID`"; `GOOGLE_CLIENT_ID` already exists (F1 sign-in) | consistent; owner registers the calendar redirect URI on the same client (T12 carry) |
| T5↔jobs | `JOB_NAMES` at 7b988eb is `['import-customers','texting-registration']`; F3 briefs 14–37 add none | consistent (append `calendar-push`) |
| T6 self | F1 `routes/jobs.ts` has `GET /:id` before any `/board` | conflict → T6 carry: register `/board` first — cost: none |
| T6↔T8/T15 | both call `updateJob`, which T6 changes (stage rules) in the same wave | consistent (call-only; T8/T15 test the auto-move and value set against the merged rules) |
| T6/T8/T9/T17 | plan says "member names from `company_members`" — it is a **view**, not a Drizzle table | consistent once noted: raw SQL in repos (global constraints) |
| T6↔permissions | `can(ctx, 'view_money_totals')` — `can` takes a `Member`; `TenantContext` has `role` + `canApproveSpend` | consistent |
| T7↔F3 T14 | `t.geocoder.failNext` exists in `FakeGeocoder` | consistent |
| T8↔T13/T14 | `ChangeOrigin { origin: 'pull' }` | consistent (Ruling 7) |
| T9↔T12 | both routers under `/api/calendar` | consistent (disjoint paths, T9 carry) |
| T12↔F3 T4/T16 | `SetupFacts` gains `calendarsConnected`; `COMING_WITH` would lose `'calendar'`, but `copy/setup.ts` (T25's) is keyed by it | conflict → Ruling CC |
| T12↔T14 | T14 fills the `POST /sync` body in T12's file | consistent (chained) |
| T13↔permissions | `systemContext(companyId)` is in `apps/api/src/permissions.ts` | consistent |
| T15↔F3 T3 | no-hard-coded-prices scan (19900/39900) | consistent (carry) |
| T16 self | test needs `compress: false`, interface has no options | gap → Ruling CD |
| T17↔F3 T21 | read-only mode test | consistent once T21 is in |
| T18↔F3 T30 | `connections` tab is `LaterTab`; T25 plan edits `LaterTab.tsx` for one tab | conflict → Ruling CA |
| T18 self | `DockApp.shipped` is the literal type `false` | gap → Ruling CB |
| T19↔T20/T21 | `useMoveJob`, `MoveJobMenu`, `MoveJobSheet`, `Timeline` imported, not edited | consistent |
| T21↔T22 | `AddHomeSheet({ customerId, onDone? })` | consistent |
| T22 self | plan says "the six F1 sources"; `JOB_SOURCES` has seven | gap → fixed in the T22 brief — cost: none |
| T22/T24/T25↔F3 T29 | `Checkbox`, `Banner` not in `@roofline/ui` at 7b988eb | consistent once T29 is in |
| T25↔F3 T32 | `SetupRow` | consistent once T32 is in |
| T27↔T18 | `readRecents` | consistent |
| T28↔T5 | T28 changes the fake's `authUrl` under `FAKE_PROVIDERS` | consistent (T28 is last) |
| T28↔F3 T36 | e2e fixtures and phone/a11y specs | consistent once T36 is in |
| T29↔F3 T37 | `assertConfirmed` | consistent (copy the function if T37 is late) |

Ruling CA: T18 creates `features/settings/ConnectionsTab.tsx` (rendering today's `connections.later` line) and maps the `connections` tab to it; T25 adds `CalendarConnection` there instead of editing the generic `LaterTab` — F3 T30 leaves `connections` as the only `LaterTab` user — cost if wrong: one extra file.
Ruling CB: `DockApp.shipped` widens from the literal `false` to `boolean` in T18 (Jobs and Calendar become `true`), with the F2/F3 "all coming soon" tests updated there — the plan requires shipped apps — cost if wrong: none.
Ruling CC: T12 keeps `'calendar'` in `COMING_WITH` (unused once `connect_calendar` is real) so `copy/setup.ts`, a `Record<ComingWith, …>` owned by T25, still compiles mid-wave; nothing returns it — cost if wrong: one dead enum value.
Ruling CD: `renderQuotePdf(i, opts?: { compress?: boolean })` (default `true`) so T16's test can read the PDF text uncompressed — cost if wrong: none.

## Waves (from the plan)

- W1: T1. W2: G1 = T2, T3, T4. W3: G2 = T5, T18.
- W4: G3 = T6, T7, T17 · G4 = T8, T9, T15 · G5 = T10, T11, T12 · G6 = T19, T22, T23.
- W5: G7 = T13, T14, T16 · G8 = T20, T21, T24 · G9 = T25, T26, T27.
- W6: T28; T29 by hand.
- Gates from F3: W1 needs F3 complete (or at least T14, T16, T21 for W4; T29, T30, T32 for G6/G9; T36 for T28).

## Tasks

## Build log
c1-crm created at f3-setup 847de3b (F3 24 of 37 merged; the rest of F3 merges into c1-crm as it lands). C1 T1 started early on c1-t1 (base 847de3b) because F3 adds no more migrations (Ruling AO); T1's 0012 also takes the parked F3 index (partial unique on texting_registrations.messaging_service_sid where not null).
Restart: F3 polish P3a landed 0012_early_reports_prune before Ruling AO reached it, so the first C1 T1 run (wf_9ced144f-9e5) was stopped early and its uncommitted output discarded; C1 migrations renumbered to 0013/0014 (brief, constraints, scan table). c1-t1 recreated from f3-setup bdc0f9f; c1-crm moved to bdc0f9f.
