# SDD ledger — plan: docs/superpowers/plans/2026-10-12-roofline-front-desk.md

Spec: docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md. Branch `d1-front-desk`, to be created from `s1-storm` once S1 is merged (C1, E1 and S1 are not built yet; at writing `origin/f3-setup` is 7b988eb). Briefs: `ops/sdd/d1/task-<N>-brief.md`; constraints: `ops/sdd/d1/global-constraints.md`. Rulings use the prefix **D**. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs and must be checked against the merged branches before each task starts.

## C1 / E1 / S1 dependencies (check against the real code when merged)

| From | Name D1 uses | D1 tasks |
|---|---|---|
| C1 T1 | `appointments` table (gains `confirmed_at`, `confirmed_via`) | T1 |
| C1 T3/T9 | `findSlots`, `DEFAULT_DURATION_MINUTES`, `busyFor`, `bookableMembers`, work hours | T8, T9 |
| C1 T6 | `createJob`, `updateJob`; `jobs.next_step`/`next_step_on` as Today follow-ups | T8, T9 |
| C1 T8 | `createAppointment`, `updateAppointment`, `setAppointmentStatus`, `listAppointmentsForCustomer` (inspection auto-move, calendar push) | T7, T8 |
| C1 T18 | `router.tsx`, `shell/apps.ts`, Settings tabs | T20, T23 |
| C1 T19/T24/T27 | `features/timeline/Timeline.tsx`, `features/appointments/AppointmentDetail.tsx`, `features/today/*` | T26 |
| C1 T25 / E1 T18 / S1 | `features/setup/SetupRow.tsx` | T24 |
| E1 T1 | `STORED_FILE_KINDS` (in `shared/proposals.ts`), `stored_files` | T1, T12 |
| E1 T5/T13 | `ObjectStore` (R2), `storeFile`, `readStoredFile` | T12, T16 |
| E1 T8 | proposal status (`getProposal`) | T7 |
| S1 T1 | migrations end at `0017`; `SMS_CONSENT_SOURCES` has `door` | T1 |
| S1 T9 | `storm_hits` | T7 |
| S1 T21 | `onStormReply` call in `hooks/twilio.ts` (Front Desk goes after it) | T14 |
| C1/E1/S1 T5/T7 | `JOB_NAMES`, `SCHEDULES`, `AppDeps`, mounts already extended | T4 |

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1↔F1 | `memberships` is global; `users.phone_e164`, `companies.phone_e164` exist | consistent |
| T4↔F3 server | the WebSocket upgrade needs the HTTP server: `server.ts` keeps `const server = app.listen(...)` | consistent |
| T4/T5↔owner rule | Claude via the Anthropic TS SDK only; no live calls in CI | gap → Rulings DA, DB |
| T4↔T7 | `WeatherSource` has only `current`; `FakeWeatherSource` lives in T4's `test/helpers.ts` | conflict → Ruling DC |
| T8↔C1 | bookings through C1's appointment repo | consistent ([C1]) |
| T10↔F3 | signature and routing helpers from `hooks/twilio.ts` / `@roofline/db/system` | consistent |
| T13↔C1 timeline | plan has "timeline cards" for calls; C1's `TimelineItem` is `'activity' \| 'text'` | gap → Ruling DG |
| T14↔S1 | inbound handler order STOP → S1 YES → Front Desk | consistent ([S1]) |
| T17↔F3 | plan sets voice URLs "on `Registrar.ensureNumber` results" — that is F3's provisioning job | conflict → Ruling DE |
| T20↔F2 | the dock badge needs `Shell.tsx` (`badgeFor`, `counts['front-desk']`) | gap → Ruling DH |
| T23↔F1 | transfer phone vs the user's own phone | gap → Ruling DF |
| T26 self | plan names `features/{customer,job}/Timeline*.tsx`, `features/calendar/AppointmentSheet.tsx`, `shell/dock/badges.ts`; real (C1) paths differ | gap → fixed in the T26 brief to C1's paths — cost: none |

Ruling DA: the only Claude client is the Anthropic TypeScript SDK (`@anthropic-ai/sdk`) behind the `Llm` seam, with model ids exactly `claude-haiku-5-5` and `claude-opus-5-5`; tests use `ScriptedLlm` only (the adapter's own test uses a scripted fake `fetch` with recorded fixtures) — owner instruction — cost if wrong: none.
Ruling DB: Task 4 adds a guard test: `anthropicFor(testConfig())` is null, the test app's `llm` is `ScriptedLlm`, and `FAKE_PROVIDERS=1` forces `ScriptedLlm` even with a key set; CI has no Anthropic key — no live API call can happen in CI — cost if wrong: none.
Ruling DC: Task 4 adds a `daily()` method returning null to `FakeWeatherSource` in `test/helpers.ts`; Task 7 adds `daily(lat, lng, days)` to `WeatherSource`/`NullWeatherSource`/NWS — keeps `test/helpers.ts` with the skeleton task — cost if wrong: none.
Ruling DE: Task 17 does not edit F3's number provisioning; voice URLs are set when Front Desk settings are first saved and by a repair pass in the `fd-health` schedule — F3's provisioning job is not D1's file — cost if wrong: up to 2 minutes before a new number answers calls.
Ruling DF: the transfer phone is prefilled from `users.phone_e164` and saved to `memberships.transfer_phone_e164` only with the recording acknowledgement — cost if wrong: none.
Ruling DG: calls and text conversations reach C1's timeline as **activities** (`kind 'call'` / `'text_conversation'`, summary text) written by the after-call job; the web timeline adds a link for those kinds — C1's `TimelineItem` type stays unchanged — cost if wrong: calls look like other activity lines.
Ruling DH: Task 20 edits `shell/Shell.tsx` once (the `'front-desk'` count from a placeholder `useFrontDeskUnread()` and a `frontDeskBadge` label); Task 26 fills the hook — the dock badges live in `Shell.tsx`, not a `badges.ts` — cost if wrong: none.

## Waves (from the plan)

- W1: T1. W2: G1 = T2, T3. W3: G2 = T4, T20.
- W4: G3 = T5, T6, T10 · G4 = T7, T8, T9 · G5 = T21, T22, T23.
- W5: G6 = T11, T12, T14 · G7 = T15, T17, T24.
- W6: G8 = T13, T19, T26 · then G9 = T16, T18, T25.
- W7: T27.

## Tasks

## Build log
d1-front-desk started at c1-crm dfa9132 (F2, F3 34/37, C1 T1-T4) as parallel Track B (AGENTS.md "Parallel tracks"). Track lead: session_0166agXYjDy39PFyUw1BXtLR, reporting to the controller session_01LXtxzoHNoWz5SACkLF1d2p. Upstream checks: C1 `appointments` exists (T1); E1 `STORED_FILE_KINDS`/`stored_files` and S1 `door`/`storm_hits` do not exist yet.
Ruling DI: D1 migrations are `0019_front_desk_schema.sql` (generated) and `0020_front_desk_grants_rls.sql` (custom) per Ruling AP; drizzle-kit generates them as 0015 on this base, so Task 1 renames the SQL, snapshot and journal tag (journal idx stays sequential) — cost if wrong: the controller re-orders the journal at track merge.
Ruling DJ: Task 1 leaves `STORED_FILE_KINDS` alone (E1 has not built it). When `e1-estimator` merges into `d1-front-desk`, the merger adds `'call_recording'` to E1's `STORED_FILE_KINDS` and appends the `stored_files` kind CHECK swap to `0020` (pre-release, nothing deployed); Task 12 waits for E1's `ObjectStore` — cost if wrong: one migration edit at merge.
