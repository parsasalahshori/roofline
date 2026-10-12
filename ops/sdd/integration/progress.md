# Integration probe ledger (`launch-integration`)

`launch-integration` is a probe branch that merges every parallel milestone track to find cross-track
problems early. It is never merged anywhere. Each pass recreates or extends it and records what it found here.

## Pass 1

Base: `origin/c1-crm` cd7d7197f6076463a778c4acdcd1fba2d0e448b0. Merged in order with `git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| e1-estimator | 4b7a850e7cfed2e2b2a9f7190354ef1c706c662a | 120ea63 | none |
| s1-storm | 1a04b04ba7775cd42bcf392ebf98644cdaaa7aba | 188b3c1 | none |
| d1-front-desk | 8f68848a97ba5d767093eb7f0fedb06828451110 | 2420070 | 12 files (below) |
| a1-agents | 288c3d3a0a8c6099ac41849a9234c93f00b06b76 | a19dc3d | 7 files (below) |
| g1-agents | 2251fe7cd0461c7e526e9e337249e4cb2a3e0121 | 89a772c | 4 files (below) |

### Conflict resolutions

d1-front-desk:
- `apps/api/package.json`: kept both (`yauzl` + `@types/yauzl` from E1, `ws` + `@types/ws` from D1), sorted.
- `package-lock.json`: took ours, then `npm install --package-lock-only`; `npm ci` clean; `npm ls playwright-core`
  shows only 1.56.1.
- `packages/db/src/index.ts`, `packages/db/src/system/index.ts`, `packages/shared/src/index.ts`: kept both barrels.
- `packages/db/src/schema/enums.ts`, `tenant.ts` imports, `TENANT_TABLES`, `company_settings` columns and checks:
  kept both. E1 and D1 tables both appended after `quote_counters`; restored the `/*` opener of the D1 comment block.
- `packages/db/src/schema/global.ts`: kept both (`building_footprints*` from E1, `line_lookups` from D1).
- `packages/db/test/migrations.test.ts`: two tests (E1 tables, D1 tables) with the shared body.
- `packages/db/test/rls.test.ts`: `APP_SYSTEM_RLS_TABLES` gets both sides; app_tenant relation list gets both
  `building_footprints` and `line_lookups`; app_system read map gets the D1 tables under E1's `Exclude<>`.

a1-agents:
- `TENANT_TABLES`, schema tables (A1 tables appended after D1's `blocked_numbers`), `packages/shared/src/index.ts`:
  kept both.
- `packages/shared/src/steps.ts` and `test/steps.test.ts`: kept all four new step types (see problem 1).
- `packages/db/test/migrations.test.ts`: A1 RLS test and `describe('A1 constraints')` added beside E1's.
- `packages/db/test/rls.test.ts`: `APP_TENANT_DELETE_TABLES` keeps D1's `blocked_numbers`; A1's
  `SELECT_INSERT_ONLY` set also holds D1's `conversation_turns`, and the app_tenant privileges test uses the set
  (its title names all four); D1's three grant tests and A1's agent_task_steps column test all kept.

g1-agents:
- `TENANT_TABLES`, enum imports, `packages/shared/src/index.ts`, migrations test: kept both.
- `tenant.ts` tail: A1 tables then G1 tables (git interleaved them; rebuilt from each side's text).
- `messages` unique (company_id, id): exactly one constraint, D1's `messages_company_id_id_uniq` (0019). G1 had
  already merged D1 T1, so 0023 adds no second one.

### Migration journal (Ruling AP)

idx 0..22, consecutive: 0000 .. 0012 (F1/F3), 0013/0014 (C1), 0015/0016 (E1), 0019/0020 (D1), 0021/0022 (A1),
0023/0024 (G1). S1 has no migrations yet (0017/0018 unused). A1's journal `when` values were older than E1's and
D1's; they were raised to 0020's `when` + 1 s and + 2 s so `when` increases with idx (problem 2).

Snapshots: each incoming track's snapshots were rebased onto the latest snapshot with a three-way merge against
the track's own base snapshot (no overlapping changes), with `prevId` following the journal. After each merge
`drizzle-kit generate --name=probe_check` reported "No schema changes"; no probe file was created.

### Checks (after all five merges)

`npm ci` clean; `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass, lint pass,
lint:css pass; vitest @roofline/web 437 pass, @roofline/ui 170 pass, @roofline/shared 997 pass,
@roofline/send-gate 495 pass. Database, API, worker and e2e suites run only in CI (no Docker here).

No duplicate exported names, enum values, job names, schedules or route mounts were found across tracks.

### Cross-track problems

1. **E1 x A1, step-type shape.** `packages/shared/src/steps.ts`: A1 Task 2 replaced `minutesSaved` on
   `StepTypeDef` with `userCreatable`, `baseline` and `units` (built with `withMinutesSaved`). E1's
   `send_proposal` and `order_exact_report` are plain `StepTypeDef` objects with `minutesSaved: () => 20/10`, so
   the combination does not typecheck (TS2739). Probe fix (A1 ledger merge rule): both built with
   `withMinutesSaved`, `userCreatable: true`, `baseline: () => 'proposal_sent'` / `'exact_report'`,
   `units: () => 1`. Owner: whichever track merges the other first (A1's ledger assigns it to the a1-agents merge
   of e1-estimator). S1's planned step types need the same when they land.
2. **A1 x E1/D1, journal `when` order.** A1's 0021/0022 `when` (1791770537854/1791770544508) is older than E1's
   0015 (1791770685269) and D1's 0020 (1791770804997). Drizzle's migrator only applies a migration whose `when`
   is newer than the last applied one, so a database already at 0020 would silently skip 0021/0022. Fresh
   databases (CI) are not affected. Fix: whoever merges A1 after E1/D1 sets 0021/0022 `when` above 0020's in
   `_journal.json` (as the probe does); A1 should not regenerate its migrations.

### CI

Run 38199485169 on 16bc0e1: Platform (lint, typecheck, tests) success; E2E (Playwright) success; v1 (node:test)
success. No merge-artifact fixes were needed after CI.

## Pass 2

Base: pass 1 head 3b2c19d. Each track fetched again (heads unchanged since the request) and merged in order with
`git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 3eb085d304b3d13f582fa4f135f02d82ae13c239 | b7746b3 | 1 file |
| e1-estimator | d2504c7cbca5c37efb2dc904198bd20522d11fa5 | 6d8ddcb | none |
| s1-storm | e2498bdd1e06ea453ef6eb2b07c9d0443dfca9f1 | 1dc7e2f | 10 files |
| d1-front-desk | de9dfc5296142bbf251cbadd6131d81ff182d813 | 6f58866 | 2 files |
| a1-agents | 7bc7777e3c2be9281520936e5e008321d6d35f9c | 5cd5422 | 7 files |
| g1-agents | 4e4dc3c57950f64b2b7eda880303adeef2d7aaa2 | 592fe18 | 11 files |

Probe-only commits: 76b41a2 and 8e665aa (storm and E1 step types, problem 1), dfca281 (job source copy, problem 3),
c7becda (G1 step types and two shared tests, problem 2), f82f31e (web tests for the combined tracks).

### Conflict resolutions

c1-crm:
- `packages/db/test/rls.test.ts`: C1 Ruling CF (app_tenant may DELETE `calendar_connections`, edited into 0014) plus
  D1's `blocked_numbers`: the delete list and the grants test title name both.

s1-storm:
- `apps/api/package.json`: both (`@anthropic-ai/sdk` from A1, `@resvg/resvg-js` from S1).
- `package-lock.json`: took ours, `npm install --package-lock-only`, `npm ci` clean, `npm ls playwright-core` only 1.56.1.
- Barrels (`packages/db/src/index.ts`, `system/index.ts`, `packages/shared/src/index.ts`), `global.ts` (S1 hail
  tables after D1's `line_lookups`), `tenant.ts` imports, `TENANT_TABLES` and `company_settings` columns: both.
- `tenant.ts` `messages`: D1's `conversation_id` and S1's `to_email`/`subject` columns; one `(company_id, id)` unique,
  D1's `messages_company_id_id_uniq`, beside S1's `messages_email_to_email_check`. Table tail: A1/G1 tables, then S1's
  block (rebuilt from each side's text).
- `packages/db/test/migrations.test.ts`: S1's `describe('S1 constraints')` after A1's; import of `MIGRATIONS_FOLDER`.
- `packages/db/test/rls.test.ts`: `APP_SYSTEM_RLS_TABLES` both; `APP_TENANT_DELETE_TABLES` = opt_outs,
  calendar_busy_blocks, calendar_event_links, calendar_connections, blocked_numbers, door_exclusions, storm_photos
  (title says so); D1's `SELECT_INSERT_ONLY` kept; app_tenant relation list gets `line_lookups` and
  `...HAIL_GLOBAL_TABLES`; app_system column list holds D1's `upd` and S1's `ins` helpers, with S1's
  `company_storms` rows placed between `calls` and `conversation_turns` (the query orders by table name);
  `describe('front desk tables')` then `describe('S1 storm tables')`.
- Journal and snapshots: see below.

d1-front-desk:
- `apps/web/src/app/router.tsx`: D1's `front-desk` and `front-desk/:conversationId` routes and E1's three estimator
  routes; both coming-soon placeholders dropped.
- `apps/web/src/shell/apps.ts`: Front Desk and Estimator both `shipped: true`.

a1-agents:
- Router: front desk and estimator routes as above plus A1's four agents routes (no agents placeholder).
- `ComingSoonKey` = `'storm' | 'estimator' | 'approvals'` (D1 removed front-desk, A1 removed agents).
- Settings: ten tabs `company, team, prices, schedule, connections, billing, setup, front-desk, agents, profile`;
  reps (and an unknown role) do not see prices, front-desk or agents. `copy/settings.ts`, `Settings.tsx` (both
  redirects and both panels) and `test/settings.test.tsx` (ten links) follow.
- `packages/shared/src/index.ts`: both (`agents-api.ts` added).

g1-agents (G1 had merged A1 T1/T2 and D1 T2/T3, all already in the probe):
- `tenant.ts`, `migrations.test.ts`, `rls.test.ts`: took ours; every G1 line is already in ours (checked line by line).
- `packages/shared/src/index.ts`: ours (G1's copy only reorders the same exports; `front-desk-views.ts` kept).
- `packages/shared/src/steps.ts`: imports from both; registry auto-merged (15 step types).
- `packages/shared/test/steps.test.ts`: the registry test lists all fifteen step types and approval classes.
- Snapshots 0021-0024 and the journal: ours (G1 changed no migration SQL; its snapshots only lack E1/S1).

### Migration journal (Ruling AP)

idx 0..24, consecutive, in number order: 0000 .. 0012 (F1/F3), 0013/0014 (C1), 0015/0016 (E1), 0017/0018 (S1, new),
0019/0020 (D1), 0021/0022 (A1), 0023/0024 (G1). Every number is present once.

`when` values (idx 17-24): 0017 1791772690993, 0018 1791772862263, 0019 1791772863263, 0020 1791772864263,
0021 1791772865263, 0022 1791772866263, 0023 1791774729941, 0024 1791774749941. S1's 0017/0018 are newer than D1's
and A1's migrations, so 0019-0022 are raised to 0018 + 1 s .. + 4 s (problem 4). 0023/0024 take G1's own new
values (G1 regenerated them after merging A1). The pass-1 A1 workaround is subsumed by this raise.

Snapshots: S1's 0017/0018 chain from E1's 0016 unchanged. 0019-0024 were rebased onto S1 with a three-way JSON merge
(base E1 0016, theirs S1 0018; no overlapping changes), and 0019 `prevId` now points at 0018. After each merge
`drizzle-kit generate --name=probe_check` reported "No schema changes"; no probe file was created.

### Ruling AY status

1. Step-type shape. A1 Task 3 (in 7bc7777) removed `minutesSaved` and `withMinutesSaved`: a `StepTypeDef` is a plain
   object with `userCreatable`, `baseline()` and `units()`. E1 (d2504c7) has not converted `send_proposal` and
   `order_exact_report` (they still set `minutesSaved`); the probe keeps the workaround, now as plain objects
   (userCreatable true, baselines `proposal_sent` / `exact_report`, units 1). S1 (e2498bd, commit e57f982) did its
   side of AY: optional `userCreatable`/`baseline`/`units` plus a hand-written `minutesSaved`; the probe takes A1's
   interface, drops S1's optional members and `StormBaselineKey`, and removes the three `minutesSaved` (S1's ledger
   plans exactly this at its A1 merge). Owner unchanged: A1 converts E1's two at its e1-estimator merge.
2. Journal `when`. A1 (7bc7777) still carries 1791770537854/1791770544508 for 0021/0022: not fixed. Still needed and
   now wider: see problem 4.

### Checks (after all six merges)

`npm ci` clean; `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass, lint pass, lint:css pass;
vitest @roofline/web 561 pass (57 files), @roofline/ui 170 pass, @roofline/shared 1263 pass, @roofline/send-gate
525 pass. Database, API, worker and e2e suites run only in CI (no Docker here).

No duplicate exported names (typecheck), table, enum value, job name, schedule or route mount was found; no two
tracks rewrite the same check constraint in their migrations.

### New cross-track problems

1. (see Ruling AY 1) E1's two step types still need A1's plain shape; the probe converts them.
2. **G1 x A1, step-type shape.** `packages/shared/src/steps.ts` on g1-agents builds `send_personal_texts`,
   `build_claim_packet`, `create_appointment` and `move_appointment` with `withMinutesSaved` (A1 Task 2), which A1
   Task 3 deleted, so the combination fails at load (`ReferenceError: withMinutesSaved is not defined`, also breaking
   drizzle-kit) and typecheck. E1's `test/steps-e1.test.ts` and S1's `test/steps-storm.test.ts` call
   `def.minutesSaved(...)`, which no longer exists. Probe fix: the four G1 defs become
   `const x: StepTypeDef<P> = { ... }` (fields unchanged), and the tests use `stepMinutes(def, p, result).minutes`.
   Owner: G1, when it merges a1-agents again (E1 and S1 fix their tests at their A1 merge).
3. **C1 x D1, job source copy.** D1 adds `front_desk` to `JOB_SOURCES` (0019 rewrites `jobs_source_check`). C1's
   `apps/web/src/copy/create.ts` `sourceNames` and `copy/jobs.ts` `source` maps lack it, so `NewJob.tsx` (48) and
   `BoardFilters.tsx` (19) fail typecheck (TS7053). Probe fix: `front_desk: 'Front Desk'` in both maps, and C1's
   `create-job.test.tsx` expects eight sources. Owner: D1 at its c1-crm merge; C1 should decide whether a person may
   pick Front Desk on the New job form (likely not: filter it from `sourceOptions` there and keep it in the board
   filter).
4. **S1 x D1/A1/G1, journal `when` order.** S1's 0017/0018 (1791772690993 / 1791772862263) are newer than D1's
   0019/0020 (1791770789451 / 1791770804997), A1's 0021/0022 and G1's own raised 0021/0022 (1791770814997 /
   1791770824997). A database already at 0018 would silently skip 0019-0022. Fresh databases are not affected.
   Fix: whoever merges D1/A1/G1 after S1 sets 0019-0022 `when` above 0018's (probe: 1791772863263 ..
   1791772866263); S1, D1 and A1 must not regenerate. Owner: the controller (Ruling AP) at the merge that first
   combines s1-storm with d1-front-desk.
5. **A1 x D1/E1, web tests for shipped apps and settings tabs** (test-only). `apps/web/test/a1-dock.test.tsx` expects
   Front Desk and Estimator unshipped, `a1-settings.test.tsx` eight tabs, `d1-settings.test.tsx` nine tabs. The probe
   updates them for the combination (Storm the only coming-soon app; ten tabs). Owner: whichever track merges the
   other.

### CI (pass 2)

Run 38204712356 on 9b242d3: Platform (lint, typecheck, tests) success; Hail service (ruff, pytest) success;
v1 (node:test) success; E2E (Playwright) failure, 29 of 30 passed.

The one failure, `apps/web/e2e/setup.spec.ts:33` "later steps say Coming with" (expects 4 "Coming with" lines, gets
3), is not a merge artifact and not cross-track: c1-crm 3eb085d fails the same test on its own (run 38201748327).
C1 Task 12 (1cd666b, calendar connect and the setup item) removed `connect_calendar: 'calendar'` from
`COMING_WITH_BY_KEY` in `packages/shared/src/setup.ts`, so the calendar row now offers actions, but the e2e spec still
expects 'Coming with the calendar'. Fix (owner C1): the spec expects 3 lines (Estimator, Front Desk, Storm Scout)
and, if wanted, checks the calendar row's connect action instead. Later, E1, D1 and S1 will each drop their own line
when they ship their setup item, so whichever track merges another must recount. Not fixed in the probe (track bug).
Side note: c1-crm's own Platform job in that run failed on an order-dependent assertion in
`apps/api/test/isolation.test.ts:304` (steps compared in a different order); it passed in the probe run.

No merge-artifact fixes were needed after CI, so ci-check was not re-run.

## Pass 3

Base: pass 2 head f8ccd37. `git fetch origin` (05:0xZ) gave the requested heads unchanged; merged in order with
`git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 1ca7b32bf11f776f7e23e212ae0460f751c853bb | 29edc62 | none (ops reports only) |
| e1-estimator | c2186ba360a503492919d6b35df0e1b60dff4c5a | 5870d7e | none |
| s1-storm | 63673a2e5f8a66b08064bd1ce32c19c8b052983f | 11e0271 | 6 files |
| d1-front-desk | 933b2f30f62598e84bd9b49ce0cf869e5b8b9a40 | 81fe0bc | 3 files |
| a1-agents | b372fb0c37f453d48203abf3b6df537ca1dd857f | fbf93c3 | 2 files |
| g1-agents | dde40c5f0a31a87737d4a443f24b40e9a53aaa7c | ff5d01a | none (ops only) |

Probe-only commits: 44c9a6d (G1 baseline labels in A1's copy, problem 1), ada88e4 (unused coming-soon helper, merge
artifact), b9132d5 (web tests for the combination, problem 3).

### Reported track fixes: not on the merged heads

The three fixes reported since pass 2 are not on the heads named for this pass, so the probe keeps its workarounds:
- C1: 1ca7b32 only adds `ops/sdd/c1/task-13-report.md` and `task-14-report.md`. The setup spec (3 lines) and the
  isolation snapshot order are in `5561dbd Merge c1-fix1 into c1-crm`, which is only on `origin/c1-int` (aa19f20).
  The setup spec reaches the probe anyway through E1 (a3991a9, identical text per C1's 9052e72); the isolation
  order fix does not (it passed in the pass-2 probe run).
- D1: the C1 Ruling CG copy (`front_desk` in `sourceNames`/`source`, filtered from NewJob's `sourceOptions`) is in
  `6f63b3a Merge c1-crm into d1-c1sync`, only on `origin/d1-c1sync`. d1-front-desk 933b2f3 still lacks it.
- G1: the plain `StepTypeDef` objects and the four `baselineLabels` are in `94a13ed Merge a1-agents into g1-agents`,
  only on `origin/g1-ma1c`. origin/g1-agents dde40c5 changes only ops files and still uses `withMinutesSaved` (11).

### Conflict resolutions

s1-storm (S1 ships Storm and adds a Storm settings tab):
- `apps/web/src/app/router.tsx`: S1's `storm/routes`, `storm/routes/:routeId`, `storm/:id` and D1's `front-desk`,
  `front-desk/:conversationId`; both placeholders (`storm/*`, `front-desk/*`) dropped.
- `apps/web/src/shell/apps.ts`: Storm and Front Desk both `shipped: true` (every dock app is now shipped).
- `apps/web/src/features/settings/tabs.ts`: eleven tabs `company, team, prices, schedule, connections, storm, billing,
  setup, front-desk, agents, profile`; reps and an unknown role do not see prices, storm, front-desk or agents.
- `Settings.tsx`: the rep redirect covers prices/storm (S1), front-desk and agents.
- `test/settings.test.tsx` (eleven links), `test/c1-routes.test.tsx` (no Coming soon note on Jobs, Calendar, Agents,
  Storm or Front Desk).

d1-front-desk:
- `apps/web/src/copy/setup.ts`, `features/setup/SetupRow.tsx`: both actions (E1 `setPrices` for `prices_and_tiers`,
  D1 `forwardCalls` for `phone_number`).
- `apps/web/e2e/setup.spec.ts`: E1 expected 3 lines (Estimator, Front Desk, Storm Scout), D1 3 lines (Estimator,
  calendar, Storm Scout). Combined, C1 T12 removed the calendar line and D1 T24 hides Front Desk's, so the page shows
  2: the spec expects `Coming with the Estimator` and `Coming with Storm Scout` (problem 2).

a1-agents:
- `apps/api/src/app.ts`: E1/S1 route imports and mounts plus A1's `agentSettingsRoutes` at `/api/agents`.
- `packages/shared/src/index.ts`: both (`agent-periods.ts` added).

No track changed `package-lock.json`, migrations or `steps.ts` since pass 2.

### Migration journal (Ruling AP)

Unchanged from pass 2: idx 0..24 consecutive, in number order, `when` strictly increasing (0019-0022 still raised to
0018 + 1..4 s; 0023/0024 G1's values). Snapshots chained by `prevId` 0000..0024. `drizzle-kit generate
--name=probe_check` reported "No schema changes"; no file created. Exactly one `messages (company_id, id)` unique:
D1's `messages_company_id_id_uniq` (0019, `tenant.ts`).

### Earlier workarounds: status

Still kept in the probe (no track has fixed them on its integration head):
- AY/BA step shape: E1's `send_proposal`/`order_exact_report` (e1-estimator still sets `minutesSaved`), S1's three
  (s1-storm still has `minutesSaved`), G1's four (g1-agents still `withMinutesSaved`); the `steps-e1`, `steps-storm`
  and `steps` tests still call `.minutesSaved(` on those tracks. G1's own fix waits on g1-ma1c.
- BA job source copy: `front_desk` in `copy/create.ts`/`copy/jobs.ts` (probe), C1 create-job test with eight
  sources. D1's version waits on d1-c1sync; the probe does not yet filter it from NewJob's `sourceOptions` (CG).
- AY/BA journal `when`: d1-front-desk, a1-agents and g1-agents still carry their own older values; probe raise kept.
- Pass-2 web test recounts (dock/tabs): extended again for Storm (problem 3).

Resolved by a track: the pass-2 CI failure (`setup.spec.ts` expecting 4 "Coming with" lines): E1 a3991a9 carries
the 3-line spec, superseded in the combination by the 2-line count (problem 2).

### Checks (after all six merges and the probe commits)

`npm ci` clean (lockfile unchanged); `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass
(after problem 1), lint pass (after the merge artifact), lint:css pass; vitest @roofline/web 781 pass (83 files,
after problem 3), @roofline/ui 170 pass, @roofline/shared 1278 pass, @roofline/send-gate 525 pass.

Merge artifact fixed: `apps/web/src/app/router.tsx` `comingSoonWindow` (and its `ComingSoon`/`ComingSoonKey`
imports) became unused once both the Storm and Front Desk placeholders were dropped (eslint no-unused-vars).

### New cross-track problems

1. **A1 x G1, baseline labels.** A1 T9-T11 `apps/web/src/copy/agents.ts` `baselineLabels` is
   `satisfies Record<BaselineKey, string>`, and G1 adds `claim_packet`, `reminder_sent`, `install_moved`,
   `follow_up_sent` to `BaselineKey`: TS1360 at `copy/agents.ts:108` and TS7053 at
   `features/agents/TimeBreakdown.tsx:26`. Probe fix (44c9a6d, identical to g1-ma1c 94a13ed): `Claim packets built`,
   `Reminders sent`, `Installs moved`, `Follow-ups sent`. Owner: G1 (land g1-ma1c on g1-agents).
2. **C1 x D1 x E1, setup "Coming with" count** (e2e only). C1 T12 drops the calendar line, D1 T24 hides Front Desk's
   line in `SetupRow` (`phoneReady`); with E1's spec the combined page shows 2 lines (Estimator, Storm Scout), not 3.
   `COMING_WITH_BY_KEY` still maps `phone_number: 'front_desk'` (D1 overrides it in the web only). Probe: spec expects
   2. Owner: D1 at its c1-crm sync: d1-c1sync 6f63b3a took C1's 4-line spec, but there C1 T12 + D1 T24 also give 2
   lines, so d1-c1sync's E2E should fail as written. E1 recounts again when it clears `prices_and_tiers`.
3. **S1 x A1/D1/E1/C1, web tests for shipped apps and tabs** (test-only, Ruling BA). S1 ships Storm and adds the
   Storm tab: `a1-dock.test.tsx` (Storm Coming soon; shipped map), `a1-settings.test.tsx` (ten tabs),
   `d1-routes.test.tsx` (Storm Coming soon), `d1-settings.test.tsx` (ten tabs, no storm), and E1's
   `e1-routes.test.tsx:150` (Front Desk Coming soon, vs D1) fail. Probe (b9132d5): no app is coming soon; eleven
   tabs. Owner: whichever track merges the other (S1 at its A1/D1 merges; E1 at its D1 merge).

### CI (pass 3)

Run 38207792011 on c23f107: Platform (lint, typecheck, tests) success; E2E (Playwright) success (including the 2-line
setup spec); Hail service (ruff, pytest) success; v1 (node:test) success. No merge-artifact fixes were needed after
CI, so ci-check was not re-run.

## Pass 4

Base: pass 3 head 23b88a9. `git fetch origin` (06:0xZ) gave the requested heads; merged in order with
`git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | eda1ad60d9825d67bac719670eee6fe3796725a7 | 80d6763 | 1 file |
| e1-estimator | a7eef1faef391e1c1f2ba894929e3dc53e6e905d | b408328 | none |
| s1-storm | 73374ba254ac63823e63d7d98cd08edadceae670 | 452e872 | none (ops only) |
| d1-front-desk | 9c15240231ff7d9155bd6cfc112755d9de3c97e1 | fe6df2f | 2 files |
| a1-agents | d4a542f36f4fe69521862d251d99f7ed861e2d57 | 458ba08 | 18 files |
| g1-agents | ef871d01ab6bdb4cc50b6f197aea1b613c5efbf6 | 43df36d | 1 file |

Probe-only commits: ac3cd95 (take D1's CG create-job test, drop the probe copy), 90a79bf (S1 dock test answers
`GET /api/proposals`, problem 2).

What the tracks brought: C1 T6 (jobs stage rules, next step, board and job view; `repos/board.ts`), the c1-fix1
merge (setup spec, isolation id order); E1 T15 (Estimator window: type an address, make a proposal; Ruling EH);
D1's c1-crm sync (Ruling CG copy, 2-line setup spec); A1 T12/T15 (owner-editable baselines, editable hourly rate)
and A1's merge of s1-storm with e1-estimator (E1 and S1 step types in A1's shape, A1 journal `when` raised);
G1's merge of A1 T3-T11 (plain step types, four baseline labels).

### Conflict resolutions

c1-crm:
- `apps/web/e2e/setup.spec.ts`: C1 now expects 3 lines (Estimator, Front Desk, Storm Scout); the probe already has
  D1 T24, so ours (2 lines: Estimator, Storm Scout) kept.

d1-front-desk:
- `apps/web/e2e/setup.spec.ts`: D1's text (same 2 lines plus a comment); identical to D1's file now.
- `packages/db/test/rls.test.ts`: ours (superset: S1's delete tables, A1's `SELECT_INSERT_ONLY` with D1's
  `conversation_turns`, the full grants title).
- After the merge, D1's `apps/web/test/create-job.test.tsx` (seven sources, CG) replaces the probe's eight-source copy
  (ac3cd95).

a1-agents (A1 carries s1-storm 63673a2 with e1-estimator, but not D1 or G1):
- `apps/api/src/app.ts`: one `agentSettingsRoutes` import (git placed A1's copy twice).
- `apps/web/src/app/router.tsx`: ours (D1's `front-desk` routes; A1 still has the `front-desk/*` placeholder).
- Settings `tabs.ts`, `Settings.tsx`: ours (eleven tabs; A1 has nine, without front-desk and profile).
- `a1-dock`, `a1-settings`, `c1-routes`, `settings` web tests: ours (Ruling BA: no Coming soon app, eleven tabs; A1's
  versions keep Front Desk coming soon and nine tabs).
- `packages/shared/src/index.ts`: ours (every barrel).
- `packages/shared/src/steps.ts`: A1's file plus G1's four (imports, `STEP_TYPES`/registry entries, the G1 block).
  `front_desk_*` stay in A1's position. E1's `send_proposal`/`order_exact_report` now take A1's text, with
  `userCreatable` in A1's place, and the probe's duplicate `resultCount` was dropped for A1's
  `const resultCount = countOf`.
- `steps-storm.test.ts`: A1's (required `baseline()`/`units()`); `steps-e1.test.ts` auto-merged to A1's text.
  `steps.test.ts`: ours (fifteen step types).
- `tenant.ts`: `AGENT_EVENT_KINDS` import in A1's sorted place; A1's tables and `TENANT_TABLES` entries are already in
  ours (A1's copies dropped).
- `packages/db/test/migrations.test.ts`: ours (D1 and G1 RLS tests; A1's `describe('A1 constraints')` is already
  in ours, and its text matches A1's).
- `packages/db/test/rls.test.ts`: ours; `SELECT_INSERT_ONLY` moved after `APP_TENANT_DELETE_TABLES` as on A1.
- Snapshots 0021/0022: ours. A1 rebuilt them on S1 0018 without D1. The 0021/0022 SQL is unchanged, and ours chains
  0020 -> 0021.
- Journal: see below.

g1-agents:
- `packages/shared/src/index.ts`: ours (every barrel).
- No conflict in `steps.ts` or `copy/agents.ts`: G1's step block and its four `baselineLabels` match the probe text
  exactly.

### Migration journal (Ruling AP)

idx 0..24 consecutive, in number order, `when` strictly increasing (checked by script):

| idx | tag | when | source |
|---|---|---|---|
| 17 | 0017_storm_schema | 1791772690993 | S1 |
| 18 | 0018_storm_grants_rls | 1791772862263 | S1 |
| 19 | 0019_front_desk_schema | 1791772863263 | probe raise (0018 + 1 s), D1 has 1791770789451 |
| 20 | 0020_front_desk_grants_rls | 1791772864263 | probe raise (0018 + 2 s), D1 has 1791770804997 |
| 21 | 0021_agents_schema | 1791780000000 | A1's own value (A1 raised it above 0018) |
| 22 | 0022_agents_grants_rls | 1791780001000 | A1's own value |
| 23 | 0023_more_agents_schema | 1791780002000 | probe raise (0022 + 1 s), G1 has 1791774729941 (problem 1) |
| 24 | 0024_more_agents_grants_rls | 1791780003000 | probe raise (0022 + 2 s), G1 has 1791774749941 |

Snapshots chained by `prevId` 0000..0024 (checked by script). After the A1 and G1 merges, `drizzle-kit generate
--name=probe_check` reported "No schema changes, nothing to migrate"; no file created. Exactly one
`messages (company_id, id)` unique: D1's `messages_company_id_id_uniq` (0019, `tenant.ts:630`).

### Earlier workarounds: status

Closed by the tracks (the probe now takes the track's text):
- C1 isolation-test id order: c1-crm eda1ad6 (`apps/api/test/isolation.test.ts` identical to C1's).
- Ruling CG job source copy: d1-front-desk 9c15240. `front_desk` is in `copy/create.ts`/`copy/jobs.ts`, is filtered
  from NewJob's `sourceOptions` and is kept in BoardFilters. C1's create-job test (seven sources) comes from D1. All
  five files are identical to D1's.
- Setup spec count: d1-front-desk carries the 2-line spec (Estimator, Storm Scout); the probe file is D1's.
- Step shape for E1's two and S1's three: a1-agents d4a542f (its s1-storm/e1-estimator merge). `steps-e1`/`steps-storm`
  tests are identical to A1's.
- G1 step shape and baseline labels (pass 3 problem 1): g1-agents ef871d0. The G1 block in `steps.ts` and the four
  labels match G1's.
- A1 journal `when` (pass 1 problem 2): A1 now carries 1791780000000/1791780001000 itself.

Still kept in the probe:
- D1 journal `when`: d1-front-desk still has 0019/0020 below S1's 0018, so the probe raise stays (Ruling BA:
  normalized at launch).
- G1 journal `when`: a new gap, now below A1's values (problem 1).
- Combination test recounts (Ruling BA, test-only): `a1-dock` (A1: Front Desk coming soon), `a1-settings` and
  `settings` (A1/C1: nine tabs), `c1-routes`, `d1-routes`, `d1-settings` (D1: ten tabs, no storm), `e1-routes`
  (Front Desk coming soon) and `steps.test` (fifteen step types). The probe keeps these: no app coming soon, eleven
  tabs. Each track still checks its own subset.
- On their own heads, e1-estimator and s1-storm still define their step types with `minutesSaved`. The probe no
  longer needs a workaround for that, because A1's merge of both carries the converted text.

### Checks (after all six merges and the probe commits)

`npm ci` clean (lockfile and package.json files unchanged this pass); `npm ls playwright-core` only 1.56.1. Through
`ops/bin/slot`: typecheck pass, lint pass, lint:css pass; vitest @roofline/web 822 pass (87 files, after problem 2),
@roofline/ui 170 pass, @roofline/shared 1278 pass, @roofline/send-gate 525 pass. The database, API, worker and e2e
suites run only in CI.

No merge-artifact fixes were needed after the merges (typecheck and lint passed first time).

### New cross-track problems

1. **A1 x G1, journal `when`.** A1 raised 0021/0022 to 1791780000000/1791780001000 (above S1's 0018). G1's
   0023/0024 (1791774729941/1791774749941, in `packages/db/migrations/meta/_journal.json` on g1-agents) are now
   older than A1's 0022, so a database at 0022 would silently skip G1's migrations. Fresh databases (CI) are not
   affected. Probe: 0023/0024 = 1791780002000/1791780003000. Fix: when G1 next merges a1-agents, raise 0023/0024
   above 0022's `when` (journal edit only; do not regenerate). Owner: G1, or the controller at the launch
   normalization (Ruling BA).
2. **S1 x E1, dock test fetch** (test-only). `apps/web/test/s1-routes.test.tsx` "the dock Storm opens /storm"
   renders `/estimator`. Since E1 T15 (721ae6e/478e9e0), `EstimatorWindow` calls `useProposals` (`GET
   /api/proposals`), which the S1 stub does not answer, so the `unexpected` check in `afterEach` fails. Probe (90a79bf):
   the test passes `{ 'GET /api/proposals': () => ({ body: { proposals: [], total: 0 } }) }` to `signedInApi`, as
   E1's own `e1-routes.test.tsx:98` does. Owner: S1, at its next e1-estimator merge.

### CI (pass 4)

Run 38211391217 on 89281c6: Platform (lint, typecheck, tests) success; E2E (Playwright) success (including the
2-line setup spec); Hail service (ruff, pytest) success; v1 (node:test) success. C1 T6's stage rules caused no
failures in the database, API or worker suites when combined with the other tracks. No merge-artifact fixes were
needed after CI, so ci-check was not re-run.

## Pass 5

Base: pass 4 head ee5fd2b. `git fetch origin` (06:5xZ) gave the requested heads unchanged; merged in order with
`git merge --no-ff`. d1-front-desk 9c15240 is unchanged and already merged (pass 4), so it was skipped.

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | cf06ba416c9e27a5325f30dd73b10352150759dc | 7457ea4 | none |
| e1-estimator | 305a899389461a2c8b49972537ec474ff94bf19a | f64ccc4 | none |
| s1-storm | a15fb2b9852f0dcd7a9c7f9354ee4a271109c890 | 8e4ab44 | none |
| d1-front-desk | 9c15240231ff7d9155bd6cfc112755d9de3c97e1 | (pass 4, fe6df2f) | skipped |
| a1-agents | 679e67e6cdf93ec1147061e418a56ed3d0e3ac11 | 61bc61f | 1 file |
| g1-agents | 8b02231a22d68f2c5329203c8b2e8e75c6da00b7 | 9a62df5 | none (ops only) |

No probe-only commits this pass.

What the tracks brought: C1 T13/T14 (calendar push and pull, busy blocks, event text); E1 T7 (measurements
route and repo, `measure.ts`); S1 T8/T9/T13 (storm match and spotter sync, the map storm layer at
`/api/map/storm-layer` and `/api/map/layer`, the Postmark bounce/complaint webhook at `/hooks/postmark` with
`POSTMARK_WEBHOOK_SECRET`, unsubscribe tokens); A1 T14 (Storm Scout pause check in `storm/plan.ts`
`draftStormPlan`, run-now and rule-facts changes, agent metrics) and A1's merge of c1-crm (C1 T6-T14, already in
the probe); G1 only a ledger carry note.

### Conflict resolutions

a1-agents:
- `packages/db/test/rls.test.ts`: ours in both hunks. A1's only change there (C1 Ruling CF: `calendar_connections`
  in `APP_TENANT_DELETE_TABLES` and the grants test title) is already in ours; ours also has D1's
  `blocked_numbers`, `SELECT_INSERT_ONLY` with `conversation_turns`, and the full title. No net change.

Checked by hand (auto-merged): `apps/api/src/app.ts` gets S1's `postmarkHooks` and `stormLayerRoutes`; the second
`/api/map` router (`/storm-layer`, `/layer`) does not overlap `mapRoutes` (`/pins`, `/area`). A1's pause check in
S1's `storm/plan.ts` stub keeps the `not yet` body; its only caller is the `storm-draft` job handler. No package or
lockfile change except `eslint.config.js` (E1, two lines).

### Migration journal (Ruling AP)

Unchanged from pass 4 (no track changed migrations, snapshots or the journal): idx 0..24 consecutive, in number
order, `when` strictly increasing (checked by script); 0019/0020 = 1791772863263/1791772864263 (probe raise),
0021/0022 = 1791780000000/1791780001000 (A1), 0023/0024 = 1791780002000/1791780003000 (probe raise). Snapshots
chained by `prevId` 0000..0024 (checked by script). `drizzle-kit generate --name=probe_check`: "No schema changes,
nothing to migrate"; no file created. Exactly one `messages (company_id, id)` unique: D1's
`messages_company_id_id_uniq` (0019, `tenant.ts:630`).

### Earlier workarounds: status

Closed by a track this pass: none.

Still kept in the probe:
- D1 journal `when`: d1-front-desk 9c15240 (unchanged) still has 0019/0020 = 1791770789451/1791770804997, below
  S1's 0018. Probe raise stays.
- G1 journal `when`: g1-agents 8b02231 added only a ledger carry note (`ops/sdd/g1/progress.md`: set 0023/0024 to
  1791780002000/1791780003000 at the next a1-agents merge). Its journal still has 0021-0024 =
  1791770814997/1791770824997/1791774729941/1791774749941. Probe raise stays.
- Ruling BA recounts (no Coming soon app, eleven settings tabs, fifteen step types): no track changed `a1-dock`,
  `a1-settings`, `settings`, `d1-routes`, `d1-settings`, `e1-routes` or `steps.test` since pass 4. A1's
  `c1-routes` change is C1's (already in the probe). a1-agents still has Front Desk coming soon and nine tabs
  because it has not merged d1-front-desk. Probe versions stay.
- `s1-routes.test.tsx` `GET /api/proposals` stub: s1-storm a15fb2b does not touch the file (S1 has not merged
  e1-estimator T15 yet). Probe stub (90a79bf) stays.

### Checks (after all merges)

`npm ci` clean (lockfile unchanged); `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass,
lint pass, lint:css pass; vitest @roofline/web 822 pass (87 files), @roofline/ui 170 pass, @roofline/shared 1278
pass, @roofline/send-gate 525 pass. The database, API, worker and e2e suites run only in CI.

No merge-artifact fixes were needed.

### New cross-track problems

None found locally. (A1 T14's `storm-pause.test.ts` second test expects `draftStormPlan` to reject `not yet`; it
must be rewritten when S1 T11 fills the drafting body, as the test's own comment says. Owner: S1 T11 / whoever
merges it with a1-agents.)

### CI (pass 5)

Run 38214809818 on d5f3cd4: Platform (lint, typecheck, tests) success; E2E (Playwright) success; Hail service (ruff,
pytest) success; v1 (node:test) success. C1 T13/T14 calendar sync, E1 T7 measurements, S1 T8/T9/T13 (storm match,
storm layer, Postmark webhook, unsubscribe) and A1 T14 (Storm Scout pause, `storm-pause.test.ts`) pass the database,
API and worker suites in combination. No merge-artifact fixes were needed after CI, so ci-check was not re-run.
(The local `ci-check` wrapper was stopped by a session time limit while Platform was still running. The run was
then followed directly through the Actions API until it completed.)

## Pass 6

Base: pass 5 head babc576. `git fetch origin` gave the requested heads unchanged; merged in order with
`git merge --no-ff`.

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 903047f88c8178fcb69d9360f3685bbf3d29af5d | a784758 | 6 files |
| e1-estimator | 7d903e5d0278ec380d5dc075e8e401bc2e69ce9b | d399195 | 2 files |
| s1-storm | 7273fcc907a668a6ff3428ef04c210d5f8ffd4b7 | 57061c2 | 6 files |
| d1-front-desk | ddb569d1aa45347ec095d140a68c612d683e2706 | ee6f869 | none (ops only) |
| a1-agents | b63d7b1dc275f6822227ffc6da9354b114a2fc8a | 95189a9 | none (ops only) |
| g1-agents | 329a9788a2a388fe75ce296b6c0077008af23f19 | 0343c6b | none (ops only) |

What the tracks brought: C1 wave 5 (T16 quote PDF, T20 Prices tab, T21 Schedule tab and calendar connection card,
T24-T27 customer/job/quote/appointment windows, map focus, search actions); E1 T8 (proposal PDF, proposals and
tier-template routes, `prices_and_tiers` setup item now real) and its c1-crm T13/T14 merge; S1 T23/T24/T27 and I2
(Storm settings tab body, ad connections cards, storm detail/results/swath map, hail legend and map storm layer,
team `stormAlertEmail`); D1, A1, G1 ledger notes only. No migration, snapshot, journal, package or lockfile change.

### Conflict resolutions

c1-crm:
- `copy/connections.ts`: kept both (S1's ad account names, C1's calendar keys).
- `settings/ConnectionsTab.tsx`: both: `CalendarConnection`, the `later` line, then `AdConnections`.
- `settings/PricesTab.tsx`: C1's form replaces the skeleton; it becomes the inner `PriceList`, and `PricesTab`
  renders `PriceList` then E1's `TiersSection`, `FinancingSection`, `EstimateSection` (as before).
- `setup/SetupRow.tsx`: all three: D1's `phoneReady` and `phone_number` case, E1's `prices_and_tiers` case, C1's
  `connect_calendar` case and its `later` naming (calendar is every member's own action).
- `test/c1-routes.test.tsx`: Prices tests get `{ ...PRICES_ROUTES, 'GET /api/pricebook' }`.
- `test/setup.test.tsx`: neither "Coming with the calendar" nor "Coming with Front Desk".

e1-estimator:
- `apps/api/src/quotes/pdf.ts` (add/add): took C1 T16's file; E1's was a scratch `PDF_COLORS` stub marked
  "take C1 T16's file" (Ruling EC). Values are identical.
- `e2e/setup.spec.ts`: combined set leaves one "Coming with" line (Storm Scout): calendar (C1), phone (D1) and
  prices (E1 T8) are real. Count 1.

s1-storm:
- `copy/connections.ts`: NEW key collision, see problem 1 below. Otherwise kept both; S1's `later` and `meta`
  wording wins (S1's newer text).
- `shell/apps.ts`, `copy/comingSoon.ts`: `ComingSoonKey = 'estimator' | 'approvals'` (storm shipped by S1,
  front-desk by D1, agents by A1).
- `shell/map/MapView.tsx`: kept both effects (C1's `?focus=` fly-to, S1's storm layer feed and hail switch).
- `test/f3-routes.test.tsx`, `test/settings.test.tsx`: Connections tests answer both `GET /api/ads/accounts` and
  `GET /api/calendar/connection` (plus `GET /api/company` in f3-routes).

Checked by hand: E1's `proposals/pdf.ts` imports only `PDF_COLORS` from C1's `quotes/pdf.ts`.

### Migration journal (Ruling AP)

Unchanged from pass 5: idx 0..24 consecutive, in number order, `when` strictly increasing (script); 0019/0020 and
0023/0024 still carry the probe raise. Snapshots chained by `prevId` 0000..0024 (script). `drizzle-kit generate
--name=probe_check`: "No schema changes, nothing to migrate"; no file created. Exactly one `messages (company_id,
id)` unique: D1's `messages_company_id_id_uniq` (0019).

### Earlier workarounds: status

Closed by a track this pass: none.

Still kept in the probe:
- D1 journal `when`: d1-front-desk ddb569d (ops only) still has 0019/0020 = 1791770789451/1791770804997.
- G1 journal `when`: g1-agents 329a978 (ops only) still has 0021-0024 = 1791770814997/1791770824997/
  1791774729941/1791774749941.
- Ruling BA recounts: `a1-settings`, `settings`, `a1-dock`, `d1-routes`, `d1-settings`, `e1-routes`, `steps.test`
  still differ from every track head (a1-agents still has nine settings tabs). Combined counts are unchanged: no
  Coming soon app (all six dock apps shipped), eleven settings tabs, fifteen step types. Added this pass: the web
  setup fixture's `prices_and_tiers` (see problem 5).
- `s1-routes.test.tsx` `GET /api/proposals` stub: s1-storm 7273fcc changed the file but not that test (S1 has not
  merged e1-estimator T15). Probe stub stays.

Watch item: S1 T11 has not landed (`storm/plan.ts` `draftStormPlan` still throws `not yet`), so A1's
`storm-pause.test.ts` is unchanged and still valid.

### New cross-track problems (fixed in the probe)

1. C1 x S1, `apps/web/src/copy/connections.ts`: both tracks add `connections.connect`. C1 T21 uses it as
   `{ google, microsoft }` (CalendarConnection buttons), S1 T24 as the string `'Connect'` (ad cards). Probe:
   C1's key renamed `connectCalendar` (`CalendarConnection.tsx` x2, `calendar-connection.test.tsx` x3); S1's
   string kept. Owner: S1 at its next c1-crm merge (or C1, if C1 renames first).
2. S1 x C1, `stormAlertEmail`: S1 T27 makes `TeamBody` members require `stormAlertEmail`; C1's new
   `test/calendar.test.tsx` and `test/appointments-suggest.test.tsx` member fixtures lack it (typecheck fails).
   Probe: `stormAlertEmail: false` on the four members. Owner: S1 at its c1-crm merge.
3. C1 x E1, Prices tab: E1's `e1-routes.test.tsx` expects `prices.comingSoon`, which C1 T20 removed (typecheck
   fails), and does not answer `GET /api/pricebook`. C1's `settings-prices.test.tsx` does not answer E1's
   `GET /api/tier-templates` and `GET /api/estimator/settings`, and its read-only test sweeps every spinbutton on
   the tab, including E1's sections (which use `disabled`). Probe: e1-routes answers the pricebook and finds
   `prices.fields.permit`; settings-prices spreads `E1_SECTION_ROUTES` and checks readonly within the five
   `prices.groups` fieldsets only. Owner: E1 at its next c1-crm merge.
4. C1 x S1, unanswered reads: C1 T21's `CalendarConnection` on the Connections tab reads
   `GET /api/calendar/connection` and `GET /api/company`, which S1's `s1-routes`, `settings-ads` and `settings`
   ("lists the ad accounts slot") tests do not answer; S1's map storm layer (`/api/map/storm-layer`) is not
   answered by C1's `map-focus.test.tsx`. Probe: the stubs added in each. Owner: S1 at its c1-crm merge.
5. E1 x web setup fixture (Ruling BA): E1 T8 drops `prices_and_tiers` from `COMING_WITH_BY_KEY`, but
   `test/setup.test.tsx` still feeds `comingWith: 'estimator'` and expects "Coming with the Estimator". Passes,
   but against a shape the server no longer sends. Probe: fixture `comingWith: null`, assertion negated. Owner: E1.

Merge-artifact fixes: none beyond the conflict resolutions above.

### Checks (after all merges and the probe commits)

`npm ci` clean (lockfile unchanged); `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass,
lint pass, lint:css pass; vitest @roofline/web 1000 pass (111 files), @roofline/ui 170 pass, @roofline/shared 1281
pass, @roofline/send-gate 525 pass. Before the probe commits: typecheck 5 errors (problems 2, 3), web 23 failures
in 5 files (problems 3, 4). The database, API, worker and e2e suites run only in CI.

### CI (pass 6)

Run 38219860264 on b8cb7dd: Platform (lint, typecheck, tests) success; E2E (Playwright) success; Hail service (ruff,
pytest) success; v1 (node:test) success. C1 wave 5 (quote PDF, Prices/Schedule tabs, calendar card, CRM windows),
E1 T8 (proposal PDF and routes, real `prices_and_tiers`) and S1 T23/T24/T27 (Storm settings, ad connections, storm
layer, `stormAlertEmail`) pass the database, API, worker and e2e suites in combination, including the setup e2e
with one "Coming with" line. No fixes were needed after CI, so ci-check was not re-run.

## Pass 7

Base: pass 6 head 6dda391. `git fetch origin` (2026-10-12) gave the requested heads, except e1-estimator, which had
moved from the named ae1da39 to d8cd04f (two ops-only commits: T20 results, Ruling EM, task reports). The fetched
heads were merged in order with `git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | c657b89b7ac61484b3f44c88d626f18ed0d4b969 | 3536f5c | none |
| e1-estimator | d8cd04f87b0230f436ef6edc7318dbe4bbb4a8bc | 5e30609 | 5 files |
| s1-storm | 65f130be896c209ca6ef35c5f108a395f6f9576e | 2735f7a | 11 files |
| d1-front-desk | 485d150f21826b735f300a08861cce5e106e5891 | 8b13ab6 | none (ops only) |
| a1-agents | ceeabf34b49e4b0cbe26091263caa927c7487a04 | bcbd3ea | 2 files |
| g1-agents | f40a8b9d5fae00d9891f7766eacd6b346aee580e | 21c9124 | 1 file |

No probe-only commits this pass.

What the tracks brought: C1 T28 (CRM, calendar, a11y and phone e2e specs; acceptance map; new quote sends a
measurement, stage moves refresh the timeline, keyboard-reachable time grid; the calendar fake); E1's own c1-crm wave 5
merge (c7a65b1) with its fixes for the pass-6 Prices tab and setup fixture items, plus ledgers; S1 T10 (storm
alerts, settle trigger, hail-health schedule; 0018 amended in place per Ruling AW: `ad_accounts` app_system grant,
`hail_runs` SELECT for app_system, `company_members` view gains `storm_alert_email`), T12 (`send_email_batch` with
the email gate and scheduled sends), T14 (`build_routes` door-knock routes), and its e1-estimator merge with the
pass-6 fixes; A1 T13 (Agents e2e specs, `agentsSeed` fixture, acceptance map); D1 and G1 ledger notes (G1 also
merged c1-crm C1 T1-T27, all already in the probe).

### Conflict resolutions

e1-estimator (E1 merged C1 wave 5 itself, so these are files the probe and E1 both resolved):
- `settings/PricesTab.tsx`: E1's text (same structure: C1's list, renamed `PricebookPart`, then the three E1 sections).
- `setup/SetupRow.tsx`: E1's text (`prices_and_tiers` case after `connect_calendar`) plus D1's `phoneReady` and
  `phone_number` case, which E1 does not have.
- `test/settings-prices.test.tsx`: E1's text (`ESTIMATOR_ROUTES`, readonly-or-disabled check). Probe copy dropped.
- `test/e1-routes.test.tsx`: E1's text (pricebook stub, `prices.fields.permit`) plus the Ruling BA dock recount
  (Storm and Front Desk not coming soon; E1 has merged neither).
- `test/setup.test.tsx`: E1's text (`prices_and_tiers` `comingWith: null`) plus D1's recount (no "Coming with Front
  Desk") and D1's "phone number step links the owner to the forwarding guide" test, which E1 does not have.

s1-storm:
- `apps/api/src/tasks/service.ts`: import list, both (`emailCompanyFacts` from S1 T12, `expireOverdueDrafts` from A1).
- `copy/connections.ts`, `settings/ConnectionsTab.tsx`: S1's text. C1's `connect = { google, microsoft }` is unchanged
  (block identical to c1-crm's); S1's ad cards use `adConnect`. Order: `CalendarConnection`, `AdConnections`, then
  one `later` line.
- `settings/CalendarConnection.tsx`, `test/calendar-connection.test.tsx`: restored to c1-crm's text (the probe's
  pass-6 `connectCalendar` rename reverted).
- `shell/map/MapView.tsx`: S1's text (both effects; only their order and one blank line differed).
- `test/appointments-suggest`, `calendar`, `map-focus`, `s1-routes`, `settings-ads`: S1's text.
- `test/settings.test.tsx`: S1's text plus the Ruling BA recount (eleven tabs; A1's `GET /api/company/settings`).
- `packages/db/test/rls.test.ts`: ours in both hunks (D1's `blocked_numbers`, `SELECT_INSERT_ONLY`, full grants title);
  S1's 0018 changes (`ad_accounts` in `APP_SYSTEM_RLS_TABLES`, its column grants and isolation rows, `hail_runs`
  SELECT, `storm_alert_email` on `company_members`) auto-merged. No later migration redefines `company_members`
  (0020 only mentions it in a comment), so S1's `CREATE OR REPLACE VIEW` in 0018 is safe in the combination.

a1-agents:
- `e2e/a11y.spec.ts`, `e2e/phone.spec.ts`: pure list conflicts at the end of each file. Both kept: C1 T28's tests
  first, then A1 T13's.

g1-agents:
- `packages/db/test/rls.test.ts`: ours (G1 lacks S1's delete tables and the full title).

### Migration journal (Ruling AP)

idx 0..24 consecutive, in number order, `when` strictly increasing (checked by script). The values are unchanged from
pass 6: 0017/0018 S1, 0019/0020 = 1791772863263/1791772864263 (probe raise), 0021/0022 = 1791780000000/1791780001000
(A1), 0023/0024 = 1791780002000/1791780003000 (probe raise). Snapshots chained by `prevId` 0000..0024 (script);
25 snapshots, 25 SQL files. `drizzle-kit generate --name=probe_check`: "No schema changes, nothing to migrate"; no
file created. Exactly one `messages (company_id, id)` unique: D1's `messages_company_id_id_uniq` (0019,
`tenant.ts:630`).

### Earlier workarounds: status

Closed by a track this pass (the probe now carries the track's text):
- Pass 6 problem 1 (copy collision): S1 65f130b renamed its key `connections.adConnect` (`AdConnections.tsx`,
  `settings-ads.test.tsx`). The probe's `connectCalendar` rename in `CalendarConnection.tsx` and
  `calendar-connection.test.tsx` is reverted to C1's text.
- Pass 6 problem 2 (`stormAlertEmail` on C1 fixtures): S1 e9036bc. The four members in `calendar.test.tsx` and
  `appointments-suggest.test.tsx` carry it (S1 uses `true`).
- Pass 6 problem 3 (Prices tab tests): E1 c7a65b1. `e1-routes` answers `GET /api/pricebook` and finds
  `prices.fields.permit`; `settings-prices` answers E1's two reads and accepts readonly or disabled.
- Pass 6 problem 4 (unanswered reads): S1 5ab121e. Calendar/connection and company stubs in `s1-routes`,
  `settings-ads` and `settings`; storm-layer stub in `map-focus`.
- Pass 4 problem 2 (`GET /api/proposals` in `s1-routes`): S1 5ab121e (in the shared route stubs).
- Pass 6 problem 5 (setup fixture): E1 09c614c. The web fixture has `prices_and_tiers` `comingWith: null`.

Still kept in the probe:
- D1 journal `when`: d1-front-desk 485d150 still has 0019/0020 = 1791770789451/1791770804997, below S1's 0018.
- G1 journal `when`: g1-agents f40a8b9 still has 0019-0024 = 1791770789451 .. 1791774749941, below S1's 0018 and
  A1's 0022.
- Ruling BA recounts, test-only (no Coming soon app, eleven settings tabs, fifteen step types): `a1-dock`,
  `a1-settings`, `settings`, `d1-routes`, `d1-settings`, `e1-routes` (dock), `setup.test` (Front Desk line and the
  forwarding test) and `steps.test` still differ from each track head. No track has merged every shipping track.

Watch item: S1 T11 has not landed (`storm/plan.ts` `draftStormPlan` still throws `not yet` on s1-storm 65f130b), so
A1's `apps/api/test/storm-pause.test.ts` is unchanged and still valid.

### Checks (after all merges)

`npm ci` clean (no package.json, lockfile or eslint config change this pass); `npm ls playwright-core` only 1.56.1.
Through `ops/bin/slot`: typecheck pass, lint pass, lint:css pass; vitest @roofline/web 1001 pass (111 files),
@roofline/ui 170 pass, @roofline/shared 1283 pass, @roofline/send-gate 525 pass. The database, API, worker and e2e
suites run only in CI.

Merge-artifact fixes: none beyond the conflict resolutions above (typecheck and lint passed first time).

### New cross-track problems

None found locally. C1 T28 and A1 T13 add e2e specs that share the seeded scenario (C1 reads board column counts such
as `Lead (8)`; A1 seeds agent tasks through `agentsSeed`); CI checks them together.

### CI (pass 7)

Run 38223884841 on 22938fb: Platform (lint, typecheck, tests) success; E2E (Playwright) success; Hail service (ruff,
pytest) success; v1 (node:test) success. C1 T28 (CRM, calendar, a11y and phone e2e), A1 T13 (Agents e2e with
`agentsSeed`), S1 T10/T12/T14 (storm alerts, settle trigger and hail-health, `send_email_batch`, `build_routes`, the
amended 0018 with the `company_members` view) and E1's C1 wave 5 merge pass the database, API, worker and e2e suites
in combination. No fixes were needed after CI, so ci-check was not re-run. (The local `ci-check` wrapper was stopped
by its time limit while Platform was still running; the run was then followed through the Actions API until it
completed.)

## Pass 8

Base: pass 7 head 6bbf064. `git fetch origin` (2026-10-12) gave exactly the requested heads. Merged in order with
`git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 1c7e4afd61cba167c8bedcd89ef833d429a3ba67 | 1ed3414 | none |
| e1-estimator | 8c42bab64530aa195fcc14bb82499dca3c30ff59 | 82f47ec | 4 files |
| s1-storm | a25973af449a54e178036e2858aa9e4f55e7e501 | 1b7adf3 | none (ops only) |
| d1-front-desk | 341c8aa9dfab37370f99f0769e8264465178bed8 | 79847f3 | none (ops only) |
| a1-agents | 0951946d62775c740eb21ac60b8f8b143dfdd91d | eb31486 | none (ops only) |
| g1-agents | 989dd0a223bbb03e054e2262da468c3f4ab8f34a | c737933 | none (ops only) |

Probe-only commit: 3e16312 (problem 1 below).

What the tracks brought: C1 whole-branch review fixes (calendar token cache and pull, OAuth client errors,
read-only calendar connect, quote value scope via `repos/scope.ts`, timeline cursor, inspection race, web slot
prefill and invalidations); E1 T10 (owner-approved exact reports, re-billing and re-pricing, aerial measure,
`exact-report-complete.ts`, poll changes), T11 (the Estimator drafts the proposal text; one approval sends it:
real `send_proposal` and `order_exact_report` handlers, `sendOneText`, `settleSentProposal`, `send_proposal`
payload `totals` now `{ tier, totalCents }[]`), T20 web (proposals on the job, review previews, signed proposals
on Today); S1, D1, A1, G1 ledger notes only. No migration, snapshot, journal, package, lockfile or eslint config
change.

### Conflict resolutions

e1-estimator:
- `apps/api/src/messaging/dispatcher.ts`: three sides meet. S1 T12 added the scheduled-email pass and loops parked
  `send_sms_batch` and `send_email_batch` steps; E1 T11 loops `PARKED_TEXT_STEP_TYPES` (`send_sms_batch`,
  `send_proposal`), passes `{ ...step, type }` and settles the proposal (`settleSentProposal`) before finishing the
  step; A1 finishes parked steps through `completeParkedStep` (tasks/service.ts, records the outcome). Result:
  S1's email pass kept; `PARKED_TEXT_STEP_TYPES = ['send_sms_batch', 'send_email_batch', 'send_proposal']` with
  E1's loop; E1's proposal block, then A1's `completeParkedStep` (E1's `finishParkedStep` import dropped,
  `getStep` kept); the doc comment names all three types.
- `apps/api/src/tasks/handlers.ts`: E1's real `send_proposal`/`order_exact_report` handlers and S1's
  `send_email_batch`/`build_routes`. E1 deleted the `notYet` helper, which S1's `create_ad_campaign` still uses
  (and `storm-skeleton.test.ts` expects 'not yet'): restored, with the comment narrowed to `create_ad_campaign`.
- `apps/web/src/features/job/api.ts`: one import of `defaultScope` (C1) and `JobSource`, `JobView`,
  `ProposalView` (E1).
- `packages/shared/src/steps.ts`: imports from both (S1/G1/A1 imports plus E1's `TIERS`, `Tier`).

The pass-8 merge commits were rebuilt once locally before any push (the E1 merge message had git's `# Conflicts`
block after the trailer); the trees are identical.

Checked by hand: the A1 e2e `agentsSeed` draft `send_proposal` step stores `{}` payload and preview, so E1's new
`totals` shape does not touch it; no other track builds a `send_proposal` payload.

### Migration journal (Ruling AP)

Unchanged from pass 7: idx 0..24 consecutive, in number order, `when` strictly increasing (script); 0019/0020 and
0023/0024 still carry the probe raise. Snapshots chained by `prevId` 0000..0024 (script); 25 snapshots, 25 SQL
files. `drizzle-kit generate --name=probe_check`: "No schema changes, nothing to migrate"; no file created.
Exactly one `messages (company_id, id)` unique: D1's `messages_company_id_id_uniq` (0019, `tenant.ts:630`).

### Earlier workarounds: status

Closed by a track this pass: none (S1, D1, A1 and G1 brought ledger notes only).

Still kept in the probe:
- D1 journal `when`: d1-front-desk 341c8aa still has 0019/0020 = 1791770789451/1791770804997, below S1's 0018.
- G1 journal `when`: g1-agents 989dd0a still has 0019-0024 = 1791770789451 .. 1791774749941, below S1's 0018 and
  A1's 0022.
- Ruling BA recounts, test-only: `a1-dock`, `a1-settings`, `settings`, `d1-routes`, `d1-settings`, `e1-routes`,
  `setup.test` and `steps.test` still differ from every track head. Combined counts unchanged by this pass: no
  Coming soon app (six dock apps shipped), eleven settings tabs, fifteen step types (E1 T10/T11 add none).

Watch item: S1 T11 has not landed (s1-storm a25973a `storm/plan.ts` `draftStormPlan` still throws `not yet`), so
A1's `apps/api/test/storm-pause.test.ts` is unchanged and still valid.

### New cross-track problems

1. **E1 x A1, parked-step outcome.** E1 T10 finishes a parked `order_exact_report` step with `finishParkedStep`
   directly: `apps/api/src/estimator/exact-report-complete.ts` (report complete, `done`) and
   `apps/api/src/jobs/scheduler/exact-report-poll.ts` `failOrder` (`needs_attention`). In the combination A1's
   time-saved model expects every finished step to pass through `recordOutcome`, so such a step got no time-saved
   snapshot (`baseline_key`, `units`, `minutes_saved` stay null, so the Agents dashboard counts 0 minutes for it)
   and no `step_done`/`step_attention` event on the task timeline. No test fails. Probe fix (3e16312): both call
   `completeParkedStep` from `tasks/service.ts` (already imported there for `refreshTask`), as the dispatcher does.
   Owner: whichever of A1 (merging e1-estimator, per Ruling AY) or E1 (merging a1-agents) merges first.

Merge-artifact fixes: the `notYet` helper restored in `handlers.ts` (above). Nothing else.

### Checks (after all merges and the probe commit)

`npm ci` clean (no package change); `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass,
lint pass, lint:css pass; vitest @roofline/web 1021 pass (114 files), @roofline/ui 170 pass, @roofline/shared 1284
pass, @roofline/send-gate 525 pass. Typecheck and lint re-run after 3e16312: pass. The database, API, worker and
e2e suites run only in CI.

### CI (pass 8)

Run 38229064772 on 69a81bd. Attempt 1: E2E (Playwright) success; Hail service (ruff, pytest) success; v1 (node:test)
success; Platform (lint, typecheck, tests) **failure**, one test of 6317: `apps/api/test/export.test.ts` "CSV
export > every export writes an audit row" (line 245: second `export.customers` audit row not seen, 1 instead of
2). Pass 8 changed neither `routes/export.ts` nor the test, and c1-crm's own CI is green on 7b6d037 (its last code
commit). Cause (by reading, not reproduced): `routes/export.ts` writes the audit row inside the `withTenant`
transaction that streams the CSV, so the client can read the whole body before that transaction commits, and the
test's next read on another connection can miss the row. Attempt 2 (re-run of the failed job, same sha): all four
jobs success. Classified as a C1 timing flake, not a merge artifact; no fix in the probe, so ci-check was not
re-run. Owner: C1 (commit the audit row before streaming, or have the test poll for the row). The local `ci-check`
wrapper was stopped by its 10-minute limit; the run was followed through the Actions API.

E1 T10/T11 (real `send_proposal` and `order_exact_report` handlers, the dispatcher's proposal settle, exact-report
poll and completion), C1's review fixes and the probe's 3e16312 pass the database, API, worker and e2e suites in
combination.
