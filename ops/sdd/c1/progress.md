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
C1 wave 2 (sibling 1, wf_a98d214b-0ab, contact 61): T2, T3, T4 on a scratch commit ce04456 (on bdc0f9f) that writes T1's shared slice from the brief (shared/{pipeline,availability,crm,csv}.ts placeholders, APPOINTMENT_*/CALENDAR_*/QUOTE_STATUSES constants with types AppointmentKind, AppointmentStatus, AppointmentSource, CalendarProvider, CalendarConnectionStatus, QuoteStatus, four barrel lines). Merge rule (T1 first): add/add conflicts -> pipeline.ts, crm.ts, csv.ts take the task branch; availability.ts = T1's constants block + T3's code below; shared/index.ts = T1's. T4 may carry a 'scratch:' commit stubbing T2's BoardStage and T3's WorkHours/Weekday: drop or override it at merge.
Task 1 (wf_0760af5c-fb7, contact 61): 2105d50, review clean, CI 38188918207 green (DB suites). Task 1: complete. Merged into c1-crm 7d37cbc. Notes: ops/sdd/c1/merge-c1-t1.md.
Hazards: `npm run db:generate -- --name x` fails (drizzle-kit 0.31 rejects the passed-through --name); from packages/db run `../../node_modules/.bin/drizzle-kit generate --name=x`. drizzle-kit emits FKs before unique constraints: 0013 was hand-reordered so jobs_company_id_id_uniq comes before the composite FKs that reference it; redo this if 0013 is ever regenerated.
Carry (after T3 merges): T1 defines WeekdayKey/WeeklyHours/DEFAULT_WORK_HOURS in packages/db/src/schema/tenant.ts; T3 adds Weekday/WorkHours/DEFAULT_WORK_HOURS in @roofline/shared. Small follow-up: type the db columns with the shared types and drop the db copies (T8/T9 must import the shared names).
Minors (deferred): 0013 also adds jobs_company_id_id_uniq (needed, not in the brief); company_settings/jobs rely on 0002's table-wide grants (tested with has_column_privilege).
Merged into c1-crm: T2 1a73b7a, T3 bbad8ec (incl. the shared work-hours carry), T4 cd99713 (kept T2/T3's pipeline.ts and availability.ts over T4's scratch stubs), then f3-setup 330ca23 => dfa9132. typecheck, lint, shared+web tests clean. Next: C1 wave 3 (T5 API skeleton, T18 web skeleton).
C1 track lead = sibling 1 (session_01MpVA7xTz6Bus8WPNZWUKRq) from 2026-10-12 (Ruling AP tracks). It owns c1-crm: merges CI-green tasks with --no-ff, typecheck and lint on the result, pushes, and logs here.
Wave 3 (wf_31ed953e-245, contact 64), base c1-crm dfa9132:
- T18 4a326e1: review clean, CI 38193832373 green (web 429 tests). Task 18: complete. Merged into c1-crm (typecheck and lint clean).
- T5 59afe96: review round 1 had 2 findings (approved and fixed), round 2 clean. CI 38193937556 on 6e59f6d failed only on pgboss.test's schedule list (3508/3509 passed); 59afe96 adds calendar-pull. Its CI run 38195221714 never started: GitHub Actions refuses ALL jobs repo-wide ("recent account payments have failed or your spending limit needs to be increased"). T5 is HELD (not merged) until CI can run again; owner action needed on GitHub billing.
Minors (deferred): T5 calendar-deps.test tests createCalendarApis directly, not via buildDeps; FakeCalendarApi.addOutsideEvent picks the first account; T18 useRecordRecent never re-records a label that loads late (revisit in T20/T21); JobsTabs reads the pathname for the active tab.
Actions outage (controller, 02:21Z): no ci-check, no merges into c1-crm until CI passes; build and verify locally, push task branches; a later wave that needs an unmerged task branches from that task branch.
c1-t5 46e54e3 = c1-t5 59afe96 + merge of c1-crm 6e38d00 (T18), so wave 4 has one base with T5 and T18. T5 stays unmerged in c1-crm until its CI passes.
Wave 4 launched from c1-t5 46e54e3, ci off: run A wf_4d0f3adc-2dd (contacts 65-66: T6, T7, T17 | T8, T9, T15); run B wf_9f291b53-d2e (contacts 67-68: T10, T11, T12 | T19, T22, T23). When CI returns: ci-check c1-t5 first, merge it, then each wave-4 branch (they already contain T5 and T18).
CI back (repo public, 02:27Z). T5: CI run 38195617057 (re-run) green on c1-t5 46e54e3 (Platform, E2E, v1). Task 5: complete. Merged into c1-crm (typecheck and lint clean).
Merged f3-setup e61ec14 (F3 T28, T37; CI 38196673343 green) into c1-crm (typecheck and lint clean).
Merged f3-setup c0d65d8 (F3 complete: review fixes A/B, T36; CI green per controller) into c1-crm (typecheck and lint clean).
Merged f3-setup 8b8400a (F3 closed: all 37 tasks, polish, integration-review fixes A-C; CI green per controller) into c1-crm (typecheck and lint clean).
Wave 4 results (run A wf_4d0f3adc-2dd contacts 65-66; run B wf_9f291b53-d2e contacts 67-68), all 12 built from c1-t5 46e54e3:
- T8 ded22af CI 38198920738 green. Task 8: complete. Merged. Carry to T13/T14 (accepted, group check): setAppointmentStatus returns { row, pushDue } | null and updateAppointment { row, warnings, pushDue } | null (brief said AppointmentRow | null); T13/T14 read .row.
- T17 aaca7b1 CI 38198917664 green. Task 17: complete. Merged.
- T6: group check found 2 criticals (createJob refused stage 'installed', so seedShowcase broke; old jobs/map tests contradicted the new rules). Lead fix 8c38060 + 1f727cd. Ruling CE: a job may START Installed (a past job: showcase, import); Won still needs a value and Lost a reason; the rule checks the value that will be stored (explicit null counts). CI pending.
- T7: lead fix e8bd48f: compound (time, id) timeline cursor (nextBefore is opaque '<iso>~<id>', plain dates still accepted; T6 writes several activities at one instant) and customer-view job cards use shared daysInStage/isStuck. CI pending (0534720 was green).
- T9 ddbd76e CI red: PUT /api/calendar/my-hours back to company hours = 500 (fixing). T15 4b8a98c CI red: most quote routes 500 (fixing).
- T10 fix dbf04b7 (Google 403 rate/quota = unavailable, not reconnect; safe JSON), T12 fix a60c99f (persist rotated refresh tokens; forget cached token on reconnect/disconnect), T22 fix 75d6e4d (new job starts Lead/Inspection/Proposal only). T11, T19, T23 unchanged. CI running.
- Merge note: T19 and T22 conflict in apps/web/test/c1-routes.test.tsx (it.each in 'C1 windows'): keep T19's ['/jobs', WINDOW_COPY.jobs.title, jobs.newJob] and expanded signedInApi, drop the '/jobs/new' and '/customers/new' rows (T22), keep T22's New job/New customer describe.
Minors (deferred): T6 memberNames includes inactive members; board runs 5 sequential column queries; T7/T17 duplicate companyZone/memberNames helpers (consolidate later); T8 double timeline line on booking an inspection; T15 finalizeQuote sets job value as a rep; T11 Graph cursor/nextLink host not checked; 'Reconnect your calendar.' defined 4 times; T19 browser-zone dates; two dollars-to-cents parsers.
- T11 553efb9 CI 38199376313, T19 da9b1e1 CI 38199380026, T23 a7937bd CI 38199383747, T22 75d6e4d CI 38199485603: all green. Tasks 11, 19, 22, 23: complete. Merged into c1-crm (T22's c1-routes.test conflict resolved per the note above; web 507 tests, typecheck, lint, lint:css clean).
- T10 dbf04b7 (8bca9d1 + 403 rate-limit fix) CI 38199497697 green. Task 10: complete. Merged into c1-crm (typecheck and lint clean).
- T15 9784634 (4b8a98c + fix: visibleQuoteCondition interpolated an undefined jobScope for owner/office, a SQL syntax error that made most quote routes 500) CI 38200008775 green. Task 15: complete. Merged into c1-crm (typecheck and lint clean).
- T9 ba8a857 (ddbd76e + fix: returning to company hours deleted the member_schedules row, which app_tenant may not delete; now stores weekly_hours JSON null = company hours) CI 38200027109 green. Task 9: complete. Merged into c1-crm (typecheck and lint clean).
- T7 e8bd48f (0534720 + lead fix: compound timeline cursor; shared stage rules in customer view) CI 38200025306 green. Task 7: complete. Merged into c1-crm (typecheck and lint clean).
- T12 ca714fc (1cd666b + a60c99f rotated refresh tokens persisted, cached token forgotten on reconnect/disconnect + ca714fc Ruling CF) CI 38200522681 green. Task 12: complete. Merged into c1-crm (typecheck, lint clean; drizzle-kit generate reports no changes).
Ruling CF: 0014 grants app_tenant DELETE on calendar_connections (the spec's disconnect deletes the stored token; links and busy blocks cascade). 0014 edited in place: no deployed database exists, test databases are rebuilt per run. Other tracks that already merged c1-crm get the new 0014 text on their next c1-crm merge (identical journal entry, no snapshot change). member_schedules stays without DELETE (T9 stores weekly_hours JSON null for "company hours").
Wave 5 launched from c1-crm b0eaadc: wf_79f210ac-cdb (contacts 69-71): T16, T20, T21 | T24, T25, T26 | T27 (Sonnet builders, Ruling AQ). T13 and T14 next (need T8 + T12; briefs: setAppointmentStatus/updateAppointment return { row, ... }, read .row).
c1-crm 3eb085d was red (CI 38201748327): E2E setup.spec still expected the calendar step as 'Coming with' (T12 made it real); Platform isolation.test compared unordered selects. Fix c1-fix1 9052e72 (setup.spec identical to E1's a3991a9 port; isolation snapshots .orderBy(id)) CI 38205567054 green (Platform + E2E). Merged.
- T6 9bf0b2c (c2a7a05 + lead fixes 8c38060, 1f727cd, 5c1b548 + e47ede7, 9bf0b2c: board test re-logs in after a 31-day clock advance (sessions last 30 days), stage-rules test follows Ruling CE, job shape includes nextStep/nextStepOn) CI 38205649287 green (Platform + E2E). Task 6: complete. Merged.
Ruling CE (addendum): a job created directly as Installed may have no value (a past job); Won still needs a value > 0, Lost a reason.
Ruling CG: job source front_desk (added by D1) is never offered on the New job form (agents create those jobs); the board filter keeps it. D1 applies it when it adds front_desk to JOB_SOURCES (done on d1-c1sync).
New rule (controller): ci-check runs with CI_JOBS="Platform E2E"; merge only when both are green. Combined c1-crm (fix1 + T6 on top of all of wave 4) verified on c1-int: CI 38207096952 green (Platform, E2E, v1) before pushing.
Wave 4 complete: T6-T12, T15, T17, T19, T22, T23 merged.
- T13 699beab (1cc5cd7 + race fixes: link deleted before the remote delete on reassign; own event's busy block removed when the link is saved) and T14 85b5373, each with c1-crm eda1ad6 merged in: CI 38208272245 / 38208275208 green (Platform + E2E). Tasks 13, 14: complete. Merged into c1-crm (typecheck, lint clean). Follow-up minors: a first push that fails leaves no link row, so sync 'failed' cannot show for it; an outside delete flips completed/no_show to canceled; all-day linked events moved outside would write midnight times.
Wave 5 (wf_79f210ac-cdb, contacts 69-71; T27 Sonnet builders): T16 183ea12, T20 15c9669, T21 447a369, T24 a08850f, T25 9507aac, T26 a99c440, T27 5c69617; each CI-green on its own (Platform). Integrated on c1-w5 (from c1-crm dfbe962): conflicts resolved in c1-routes.test (placeholder rows of now-real screens dropped; one @roofline/shared import) and copy/connections.ts (T25's block plus T24's short providerName). Group-check fixes on c1-w5 6a1cd31: MapView clears handledFocus when ?focus= goes away (a repeat focus link flies again; test added); the appointment sheet's useCalendarProvider shares Settings' crmKeys.connection cache (a disconnect updates it). Web 620 tests local; c1-w5 CI 38211185583 green (Platform, E2E, v1). Tasks 16, 20, 21, 24, 25, 26, 27: complete. Merged into c1-crm (typecheck, lint clean).
Follow-ups (deferred): map focus does nothing when the property's pin is outside the current box or the map is in clusters mode (look up the property's point and fly there); T20 job mutations do not invalidate customer views (stale caches across features); duplicated company-zone helpers (T20, T21, T27) and 'join non-empty parts' (T16); T25/T26 duplicate material option strings; first-push failure has no link row (no sync 'failed').
Next: T28 (e2e, acceptance map, docs), then the whole-branch C1 review. T29 (manual smoke with real Google and Outlook calendars) parked for the owner: needs real accounts and OAuth credentials.
- T28 9dc2423 (2484416 e2e specs crm/calendar + phone/a11y additions, c1-acceptance.md, README calendar section; 9dc2423 three app bugs the new e2e caught: New quote posted {} (now sends defaultScope's measurement), stage moves did not refresh the timeline (useMoveJob invalidates ['timeline']), calendar time grid was not keyboard reachable (labelled focusable region)). Fake calendar authUrl self-callback under FAKE_PROVIDERS only. CI 38221120268 green (Platform, E2E desktop+phone, v1). Task 28: complete. Merged into c1-crm.
C1 build complete: Tasks 1-28 merged. Task 29 (manual smoke with real Google and Outlook calendars) parked for the owner (real accounts + OAuth credentials); c1-acceptance.md links its runbook docs/superpowers/c1-manual-smoke.md, not yet written. Next: whole-branch C1 review.
Whole-branch C1 review (4 parallel reviewers: db/RLS, API/permissions, calendar sync/jobs, web). No IDOR, OAuth CSRF, token leak, CSV injection or tenant-isolation hole found. Confirmed findings being fixed on branches c1-rev-a (API/db), c1-rev-b1 (tokens/providers/push), c1-rev-b2 (pull/all-day), c1-rev-c (web), no schema changes:
- important: reps see quote money on jobs canSeeJobValue hides (quotes use jobScope; timeline 'marked final · $X'); worker keeps a dead cached token after reconnect (cache keyed by connection id only, separate process); bad/expired OAuth client secret (invalid_client) marks every connection error; push on an errored own connection drops the link and orphans the event; pull window never re-baselined (Outlook stops syncing new dates ~60 days after connect) - fix stores a baseline date inside sync_cursor and resyncs daily; all-day outside events stored as UTC midnights block two local days and shift linked all-day appointments; calendar slot click does not prefill date/time; agenda drops multi-day/started-before-range appointments.
- minor: OAuth callback (GET) bypasses read-only mode; extreme timeline cursor date -> 500; inspection auto-move race can move a Won job back; stale timelines after job/customer edits; appointment form hides the server's message; appointments invalidate an unused ['jobs'] key; double appointment actions.
Deferred (need a schema change or a design call; C1 migrations are fixed at 0013/0014): failing calendar connections can starve healthy ones in the pull fan-out (needs last_pull_attempt_at); event creation is not idempotent across a timed-out retry (Google id / Graph transactionId); calendar switch edge cases (stale page applied to the new calendar; Graph updates events in the old calendar); pull/push busy-block race window; reps can read the full price list through a quote (the editor recalculates in the browser; owner to rule); desktop has no Board/List toggle for /jobs (design call).
