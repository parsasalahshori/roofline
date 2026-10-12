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

## Pass 9

Base: pass 8 head 713e455. `git fetch origin` (2026-10-12) gave exactly the requested heads. Merged in order with
`git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 5d2e3bdf8c302084c9e98490c93a1b9846438f27 | 6e64bec | none |
| e1-estimator | 0d1c93239a810641aab33a0d66aa9943200fc934 | 497e896 | 3 files |
| s1-storm | a3fc7a9e7f1fdeed54886f6bc698d406120e06d8 | c943d9a | 2 files |
| d1-front-desk | a270c81696b70eee62e5a7f58779e9225ae4b696 | 3db6aeb | none (ops only) |
| a1-agents | fa34cfd7544d06c440d0e5d10206ded91b4f8937 | a5686c6 | none |
| g1-agents | 9b095fdd97b48fd7b61222309e20789a1182452e | aad9cb8 | 20 files (all ours) |

Probe-only commit: 09c06d2 (merge-artifact fixes below).

What the tracks brought: C1 72609eb (export audit row committed in its own transaction before the CSV streams);
E1 T12 (homeowner proposal link: view, sign, decline; `proposal-common.ts`, `proposal-public` repo), T13 fixes
(step results count what happened, `ready` proposals re-priced, one completion per exact report, link token kept out
of the error log, measure handoff), and 961b654 (parked exact-report steps finish through `completeParkedStep`, with
a stub `completeParkedStep` in `tasks/service.ts` that A1's real one replaces); S1 T11 (`draftStormPlan` drafts the
real plan: text, email, routes, two ad campaigns, steps saved OFF with a reason via `NewTask.steps[].off`), T15/T26
(storm landing page and requests, YES replies book a check, storm results and `/api/storms`), T20/T21/T25/T29
(door outcomes, door-knock routes on the phone, review previews and Edit for storm steps, smoke scripts, Google/Meta
link fixes); A1 review fixes T16/T17 (one `finished` event writer, role-aware money/rule facts, safe recount,
run-now pause check, ESLint one-writer guard, `create_ad_campaign` units read `campaignId`); G1 merged e1-estimator
8c42bab (already in the probe) plus its T13b brief; D1 ledger only. No migration, snapshot, journal, package,
lockfile or ESLint-boundary conflict.

### Conflict resolutions

e1-estimator:
- `estimator/exact-report-complete.ts`, `jobs/scheduler/exact-report-poll.ts`: E1's text (it now calls
  `completeParkedStep` itself; result `{ ordered: 1 }` / `{ ordered: 0 }` per E1 T13).
- `tasks/service.ts`: A1's import list and A1's real `completeParkedStep` (with `recordOutcome`); E1's stub
  `completeParkedStep` (its comment says A1's body replaces it at merge) and E1's duplicate `finishParkedStep`
  import dropped.

s1-storm:
- `storm/plan.ts`: S1 T11's body, with A1 T14's Storm Scout pause check moved to the start of the drafting
  transaction (`isAgentPaused` → return null; A1's ledger asks for it before the draft insert, in the same
  transaction). `draftStormPlan` now returns `{ taskId } | null` (null = paused; no task, no plan-ready alert).
  See problem 1.
- `routes/storms.ts` (auto-merged, edited in the merge): `POST /api/storms/:id/plan` answers 409 "Storm Scout is
  paused. Turn it back on in Agents to draft a plan." when the draft returns null.
- `tasks/service.ts` `createTask`: A1's `createdBy` field and `allowInternalStepTypes` / `isUserCreatableStepType`
  gate kept, then S1's `off` handling (all S1 step types are `userCreatable: true`, so the storm plan passes the
  gate). S1's `OFF_STEP_TITLES: Record<StepType, string>` named only demo, S1 and E1 types; the six D1/G1 types
  (`front_desk_call`, `front_desk_texts`, `send_personal_texts`, `build_claim_packet`, `create_appointment`,
  `move_appointment`) were added (problem 2).
- `apps/api/test/storm-pause.test.ts` (watch item, see below): rewritten for T11.

g1-agents: all 20 conflicted files (`app.ts`, `router.tsx`, `a1-dock.test.tsx`, journal, snapshots 0019-0024, db
barrels, `enums.ts`, `global.ts`, `tenant.ts`, `migrations.test.ts`, `rls.test.ts`, shared barrel, `steps.ts`,
`steps.test.ts`) taken as ours. G1's new code is only its e1-estimator 8c42bab merge, which the probe already has
(newer); every G1 item checked (step types, `agentSettingsRoutes`, `line_lookups`, barrels) is present in ours. The
merge changed only `ops/sdd/g1/`.

Checked: Ruling AV order in `hooks/twilio.ts` (S1 `onStormReply` first; no G1 or D1 inbound call in the probe yet);
no raw `finishParkedStep`/`finishClaimedStep` outside `tasks/service.ts`; A1's new ESLint one-writer rule passes on
S1 and E1 code; A1's one-writer test passes.

### Migration journal (Ruling AP)

Unchanged from pass 8: idx 0..24 consecutive, in number order, `when` strictly increasing (script); 0019/0020 and
0023/0024 still carry the probe raise. Snapshots chained by `prevId` 0000..0024 (script); 25 snapshots, 25 SQL files.
`drizzle-kit generate --name=probe_check`: "No schema changes, nothing to migrate"; no file created. Exactly one
`messages (company_id, id)` unique: D1's `messages_company_id_id_uniq` (0019, `tenant.ts:630`).

### Earlier workarounds: status

Closed by a track this pass (the probe now carries the track's text):
- Pass 8 problem 1 (E1 x A1 parked-step outcome): E1 961b654 calls `completeParkedStep` in
  `exact-report-complete.ts` and `exact-report-poll.ts` `failOrder`. Probe 3e16312 superseded.
- Pass 8 CI flake (C1 export audit race, `export.test.ts:245`): C1 72609eb commits the audit row in its own
  transaction before streaming.

Still kept in the probe:
- D1 journal `when`: d1-front-desk a270c81 still has 0019/0020 = 1791770789451/1791770804997, below S1's 0018.
- G1 journal `when`: g1-agents 9b095fd has 0019-0024 = 1791770789451 .. 1791774749941 (G1 has not merged s1-storm),
  below S1's 0018 and A1's 0022.
- Ruling BA recounts, test-only: `a1-dock`, `a1-settings`, `settings`, `d1-routes`, `d1-settings`, `e1-routes`,
  `setup.test` and `steps.test` still differ from every track head. Combined counts unchanged: no Coming soon app,
  eleven settings tabs, fifteen step types (no track added a type, tab or app this pass).

Watch item, now acted on: S1 T11 landed a real `draftStormPlan`. `storm-pause.test.ts` now uses the 4-argument
signature; the paused case expects `null` and no Storm Scout task; the unpaused case inserts an Omaha storm and a
`company_storms` row (no hits) and expects one `storm_plan` task in `draft` with the returned id. Owner: A1 (its
ledger already assigns the rewrite to its next s1-storm merge).

### New cross-track problems

1. **S1 T11 x A1 T14, `draftStormPlan` pause.** S1's body has the comment "A1 T14 inserts the Storm Scout pause check
   here" but no check, and returns `Promise<{ taskId }>`; A1's check returns early with no value. Combined, a paused
   Storm Scout must return something: the probe returns `null` (`storm/plan.ts`), the job handler ignores it, `POST
   /api/storms/:id/plan` answers 409 with a new plain sentence, and `storm-plan.test.ts`'s `draft()` helper throws on
   null (09c06d2). Owner: S1 or A1, whichever merges the other first; S1 owns the 409 wording.
2. **S1 T11 x D1/G1, `OFF_STEP_TITLES`.** `tasks/service.ts` `OFF_STEP_TITLES: Record<StepType, string>` lists only
   demo, S1 and E1 types, so it does not typecheck once D1's and G1's six step types are in `StepType`. Probe adds
   the six titles. Owner: whichever of S1/D1/G1 merges the others (S1 when it merges d1-front-desk or g1-agents).
3. **A1 rerun x S1 OFF steps (not fixed, design).** `rerunTask` copies an expired plan's steps as `{ type, payload }`
   and re-checks each payload, so an expired storm plan with an OFF step (for example `customerIds: []`, no address)
   reruns as a 400 on `steps.N.payload`, and a rerun turns every OFF step back on. No test covers it. Fix: carry
   `off: step.errorPlain` for steps with `enabled = false` in `rerunTask`'s copy (or re-draft storm plans through
   `draftStormPlan`). Owner: A1 with S1.

Merge-artifact fixes (09c06d2): duplicate `type StepRow` import in `messaging/send-batch.ts` (E1 T11 and S1 T11
both added it; TS2300); `storm-plan.test.ts` `draft()` helper for the nullable return.

### Checks (after all merges and the probe commit)

`npm ci` clean; `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass (after 09c06d2), lint
pass, lint:css pass; vitest @roofline/web 1129 pass (124 files), @roofline/ui 170 pass, @roofline/shared 1290 pass,
@roofline/send-gate 525 pass. The database, API, worker and e2e suites run only in CI.

### CI (pass 9)

Run 38239319966 on e5715fc, attempt 1: Platform (lint, typecheck, tests) success; E2E (Playwright) success; Hail
service (ruff, pytest) success; v1 (node:test) success. S1 T11/T15/T20/T21/T25/T26/T29, E1 T12/T13 and 961b654, A1's
review fixes, C1's export fix and the probe resolutions (`draftStormPlan` pause returning null, the 409 on
`POST /api/storms/:id/plan`, `OFF_STEP_TITLES` for D1/G1 types, the rewritten `storm-pause.test.ts`) pass the
database, API, worker and e2e suites in combination. `export.test.ts` passed. No fixes were needed after CI, so
ci-check was not re-run. (The local `ci-check` wrapper was stopped by its time limit; the run was followed through
the Actions API until it completed.)

## Pass 10

Base: pass 9 head 89825cc. `git fetch origin` (2026-10-12): c1-crm 5d2e3bd (already merged, skipped); g1-agents had
moved past the requested e8ed4cc to 40c2f60 (G1 T11/T12 briefs only), and 40c2f60 was merged. Merged in order with
`git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 5d2e3bdf8c302084c9e98490c93a1b9846438f27 | (already in the probe) | - |
| e1-estimator | a60330f8f4afa89ba8a5eb1cde9d1cee3ca0a73f | c201ac3 | 2 files |
| s1-storm | 882445625cf3547bc405061134c433a03393a4b7 | 2b5f010 | 3 files |
| d1-front-desk | 1541fae47fe45eed5a27e0bfe8ce233c7847b00a | 41f8e3c | none (ops only) |
| a1-agents | a956d4004d5c73994dab85aa62da530f873e2d05 | e8d9f54 | 8 files |
| g1-agents | 40c2f60711fc9c3fde391a44c9e1b4ab30483bdb | 4580a32 | none (ops only) |

Probe-only commit: 87068ca (merge artifact, below). After the merges s1-storm moved to 2d1555a (ops briefs R1-R4
only); it was not merged this pass.

What the tracks brought: E1 T13 (tamper-evident signed PDF stored privately in R2, `makeSignedPdf` with job meta,
`stored-files` repo, email copy, Ruling EP) and T22 (estimator smoke script and guards, runbook); S1 T19 (real
`create_ad_campaign` handler: paused campaign at the approved maximum, then enabled; ad sync, landing URL from the
storm page, `ad-campaign-sync` repo); A1 T18 (web review fixes on the Agents screens) and T19 (storm draft
replacement through the task service: `replaceDraftPlan` split into `lockStormPlan` + `supersedeDraft` +
`linkStormPlan`; the ESLint one-writer list grows to `finishClaimedStep`, `finishParkedStep`, `expireOverdueDrafts`,
`moveStep`, `updateTask`), A1's own merge of e1-estimator 2702fb2 and s1-storm c510ea8 with the Ruling BC pause; D1
and G1 ledger notes and briefs only. No migration, snapshot, journal, dependency or lockfile change.

### Conflict resolutions

e1-estimator:
- `apps/api/package.json` scripts: both `smoke:estimator` (E1) and `smoke:storm` (S1).
- `apps/api/src/jobs/handlers.ts`: E1's `'signed-pdf': makeSignedPdf(deps, companyId, proposalId, meta)` plus S1's
  storm job handlers.

s1-storm:
- `tasks/handlers.ts`: S1's text (real `createAdCampaignHandler`; the probe's `notYet` helper goes, nothing uses it).
- `messaging/dispatcher.ts`: ours (same three parked types; S1's own file lacks A1's `completeParkedStep`).
- `packages/shared/src/steps.ts`: imports from both (G1's `claimsGuard`, `FOLLOW_UP_KINDS`).

a1-agents (A1 merged older E1/S1 heads; the probe has newer ones):
- `tasks/handlers.ts`: ours (S1 T19's real `create_ad_campaign`; A1's copy still has `notYet`).
- `shell/apps.ts`: ours (`ComingSoonKey = 'estimator' | 'approvals'`; Front Desk shipped by D1).
- `packages/db/test/rls.test.ts`: ours (D1's `conversation_turns` in `SELECT_INSERT_ONLY`, `blocked_numbers` in the
  delete list and title).
- `steps.ts`: G1 imports kept; A1's `order_exact_report` units (`ordered`) auto-merged.
- `dispatcher.ts`: A1's comment wording.
- `storm/plan.ts`, `test/storm-pause.test.ts`, `test/storm-plan.test.ts`: A1's text (see item 4). The probe's
  `plan.ts` is now identical to a1-agents.

Checked by hand: `hooks/twilio.ts`, `send-batch.ts`, `router.tsx` unchanged this pass (Ruling AV order as in pass 9);
A1's wider one-writer ESLint rule passes on E1, S1, D1 and G1 code; S1 T19's `create_ad_campaign` result
(`campaigns: 1`) is counted by A1's units (`campaignId` or `campaigns`); no remaining `replaceDraftPlan` caller.

### Migration journal (Ruling AP)

Unchanged from pass 9: idx 0..24 consecutive, in number order, `when` strictly increasing (script); 0019/0020 still
carry the probe raise (1791772863263/1791772864263); 0021-0024 are 1791780000000 .. 1791780003000 (A1's own raised
0021/0022). Snapshots chained by `prevId` 0000..0024 (script); 25 snapshots, 25 SQL files. `drizzle-kit generate
--name=probe_check`: "No schema changes, nothing to migrate"; no file created. Exactly one `messages (company_id,
id)` unique: D1's `messages_company_id_id_uniq` (0019, `tenant.ts:630`).

Controller note (S1 R1, `storms.merged_into` added to 0018 in place under Ruling AW): not landed. Neither s1-storm
8824456 nor the newer 2d1555a (nor any `s1-*` branch) carries `merged_into`; 2d1555a has only the R1 brief. Nothing to
rebuild this pass. When R1 lands, 0019-0024 snapshots must be rebuilt on the new 0018 snapshot in the probe, and every
track that carries its own snapshots after 0018 (A1's 0021/0022 on s1-storm c510ea8; D1's 0019/0020 and G1's
0019-0024, which do not chain from S1's 0018 at all) will disagree with that chain.

### Earlier workarounds: status

Closed by a track this pass (the probe carries the track's text):
- Pass 9 problem 1 / item 4 (Ruling BC pause): a1-agents a956d40 carries it: `isAgentPaused` first in the drafting
  transaction, returns null, `Promise<{ taskId } | null>`, job ignores the value; `storm-pause.test.ts` rewritten
  (paused: null, no task, `plan_task_id` null; unpaused: one draft `storm_plan` with the returned id). Two
  differences from the pass-9 probe text: `storm-plan.test`'s `draft()` uses a non-null assertion instead of
  throwing (a null would still fail the test on `.taskId`), and the 409 on `POST /api/storms/:id/plan` is NOT in
  either track (A1's `routes/storms.ts` predates S1 T26's plan route; S1 has not touched it). The probe keeps the 409
  ("Storm Scout is paused. Turn it back on in Agents to draft a plan."); owner S1 (or A1 at its next s1-storm merge).
- Pass 9 problem 2 / item 5, half: a1-agents carries `front_desk_call` and `front_desk_texts` in `OFF_STEP_TITLES`;
  the probe's duplicates were removed (87068ca). The four G1 titles (`send_personal_texts`, `build_claim_packet`,
  `create_appointment`, `move_appointment`) are still probe-only; owner S1 at its g1 merge (Ruling BC).

Still kept in the probe:
- D1 journal `when`: d1-front-desk 1541fae has 0019/0020 = 1791770789451/1791770804997 (and no E1/S1 entries).
- G1 journal `when`: g1-agents 40c2f60 has 0019-0024 = 1791770789451 .. 1791774749941, below S1's 0018 and A1's
  0021/0022.
- Ruling BA recounts, test-only: `a1-dock`, `a1-settings`, `settings`, `d1-routes`, `d1-settings`, `e1-routes`,
  `setup.test` and `steps.test` still differ from every track head. Combined counts unchanged: no Coming soon app
  (six dock apps shipped), eleven settings tabs, fifteen step types.

Item 6 (pass 9 problem 3, storm_plan rerun, Ruling BC): not implemented by any track. A1 has the Task 20 brief (a
storm_plan rerun re-drafts through `draftStormPlan` in the rerun route, 409 when paused; other reruns keep each step's
off state via `off: errorPlain`), but `rerunTask` on a1-agents a956d40 still copies `{ type, payload }` with no
storm_plan branch. S1's half (re-drafting expired/declined plans: whole-branch review item 1) is not done either:
`lockStormPlan` still refuses a non-draft plan and `routes/storms.ts` `REDRAFTABLE` is `['draft']`. Owners: A1 T20
and S1.

### New cross-track problems

None new beyond the 409 above (still probe-only) and the pending S1 R1 snapshot rebuild.

Merge-artifact fixes (87068ca): `OFF_STEP_TITLES` listed `front_desk_call`/`front_desk_texts` twice (A1's copy and
the probe's pass-9 addition; TS1117).

### Checks (after all merges and the probe commit)

`npm ci` clean (no package change); `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass
(after 87068ca), lint pass, lint:css pass; vitest @roofline/web 1171 pass (126 files), @roofline/ui 172 pass,
@roofline/shared 1292 pass, @roofline/send-gate 525 pass. The database, API, worker and e2e suites run only in CI.

### CI (pass 10)

Run 38244113600 on 34243bf, attempt 1: Platform (lint, typecheck, tests) success; E2E (Playwright) success; Hail
service (ruff, pytest) success; v1 (node:test) success. E1 T13/T22 (signed PDF, R2, smoke guards), S1 T19 (real
`create_ad_campaign`, ad sync), A1 T18/T19 (web review fixes, `lockStormPlan`/`supersedeDraft`/`linkStormPlan`, the
wider one-writer rule) and A1's Ruling BC pause pass the database, API, worker and e2e suites in combination with
the probe's 409 and 87068ca. No fixes were needed after CI, so ci-check was not re-run. (The local `ci-check` wrapper
was stopped by its time limit; the run was followed through the Actions API until it completed.)

## Pass 11

Base: pass 10 head 1af6f40. `git fetch origin` (2026-10-12): c1-crm 5d2e3bd (already merged, skipped); e1-estimator
had moved past the requested 2f24bff to f44e536 (one ledger line, "controller accepts EQ-ET"), and f44e536 was merged.
Merged in order with `git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 5d2e3bdf8c302084c9e98490c93a1b9846438f27 | (already in the probe) | - |
| e1-estimator | f44e536d39bc2c85db77c842b2b878ece11df7b1 | b9462bb | 1 file |
| s1-storm | 1c123b3f1a9c25a742b6931f5cdb2a57213fc102 | 0bca571 | none |
| d1-front-desk | 1c90be5ead680dce2a3c13a94af3b7863d20ddd4 | e97bf60 | 2 files |
| a1-agents | d0c012a8c2f6516ea866eaa65c33311076aa8215 | c0519f8 | none (ops only) |
| g1-agents | f6a80bfb57008ca667b6237a003fb23b9736b3ba | d5f92c2 | 19 files |

No probe-only commit this pass (no merge-artifact fix was needed).

What the tracks brought: E1 T21 (estimator e2e: address to sent in 3 clicks, homeowner signs on a phone, a11y scans
of the estimator, measure, proposal and homeowner pages, `seedFootprintFixture` in the e2e reset, E1 acceptance map),
the read-only option card's axe fix, and its whole-branch review ledger and Rulings EQ-ET; S1 I5 (the landing page
outlives its campaign, no campaign without landing pages, campaign length within 30 days, one ad error copy) and the
R1-R4 review fix briefs; D1 its c1-crm 5d2e3bd sync (SetupRow) and wave 6A ledger notes (wave 6A code is not on
d1-front-desk yet); A1 ledger notes (Task 21 brief, the Ruling AW merge rule); G1 its own merge of s1-storm 8824456
(older than the probe's S1) plus briefs. No migration SQL, journal, dependency or lockfile change.

### Conflict resolutions

e1-estimator:
- `apps/web/e2e/fixtures.ts` imports: both (`seedFootprintFixture` from E1, `seedAgentsFixture` from A1).

d1-front-desk:
- `features/setup/SetupRow.tsx`: D1's `later` line (calendar and phone number steps ignore the server's "coming
  with"; same behavior as the probe's `phoneReady`, since `phone_number` only ever carries `front_desk`); ours for the
  action switch (D1's side repeated the `connect_calendar` case and lacks E1's `prices_and_tiers`).
- `test/setup.test.tsx`: ours ("Coming with the Estimator" is gone: E1 shipped its setup item; Ruling BA).

g1-agents (G1's file versions are its own s1-storm 8824456 resolutions; every line G1 has that the probe lacks was
checked):
- `tasks/service.ts` `OFF_STEP_TITLES`: G1 now carries the four G1 titles (item 5). Kept A1's two D1 titles where
  A1 put them and G1's `// G1 (Ruling BC)` comment; G1's side would have listed the D1 titles twice.
- `Settings.tsx`, `tabs.ts`, `shell/apps.ts`, `a1-dock`, `a1-settings`, `c1-routes`, `settings` tests: ours (G1 has
  no D1: nine tabs, Front Desk "Coming soon", A1's older settings test).
- `steps.ts`, `steps-storm.test.ts`: ours (A1's `create_ad_campaign` units read `campaignId` or `campaigns`; G1 has
  S1's older `campaigns`-only counter). `enums.ts`, `tenant.ts`, `steps.test.ts`: ours (G1 has nothing extra).
- Snapshots 0019-0024: ours. G1's parse identical to the probe's (0019-0022 fully, 0023/0024 differ only in
  `id`/`prevId` uuids); the conflicts were table key order only, so the probe text is kept to avoid ~56k lines of
  reorder churn. SQL 0019-0024 byte-identical.

Checked by hand: `hooks/twilio.ts` (Ruling AV), `dispatcher.ts`, `tasks/handlers.ts`, `send-batch.ts`, `router.tsx`,
`routes/storms.ts`, `storm/plan.ts` unchanged this pass. The only API code change is S1 I5 (`storm/ad-campaign.ts`,
`storm-pages` repo).

### Migration journal (Ruling AP)

Unchanged from pass 10: idx 0..24 consecutive, in number order, `when` strictly increasing (script). Snapshots chained
by `prevId` 0000..0024 (script); 25 snapshots, 25 SQL files. `drizzle-kit generate --name=probe_check`: "No schema
changes, nothing to migrate"; no file created. Exactly one `messages (company_id, id)` unique: D1's
`messages_company_id_id_uniq` (0019, `tenant.ts:630`).

Ruling AW (S1 R1, `storms.merged_into` in 0018 in place): not on s1-storm 1c123b3; no track head carries
`merged_into` in packages/db or apps. It exists only on the unmerged task branch `s1-r1` 3976cd9 (0018 SQL +9 lines,
0018 snapshot: `storms.merged_into` and `storms_merged_into_storms_id_fk`, schema `global.ts`, repos, `rls.test`,
`storm-merged.test`). R1 keeps 0018's snapshot `id` and `prevId`, so later `prevId` links stay valid, but every
snapshot after 0018 lacks the column and drizzle-kit would then report a change. Nothing rebuilt this pass. When R1
lands on s1-storm: add the column and FK to the probe's 0019-0024 snapshots. Tracks whose own post-0018 snapshots
will disagree: A1 0021/0022 (a1-agents), G1 0019-0024 (g1-agents, chained from S1's 0018 since its s1 merge), A1's
`a1-t4` D1 0019/0020 rebuild; D1's own 0019/0020 on d1-front-desk still chain from 0014 (no S1 at all).

### Earlier workarounds: status

Closed by a track this pass (the probe carries the track's text):
- Item 2 (G1 journal `when`): g1-agents f6a80bf's journal is identical to the probe's (0019/0020 =
  1791772863263/1791772864263, 0021-0024 = 1791780000000 .. 1791780003000), from its s1-storm merge.
- Item 5 (`OFF_STEP_TITLES` G1 titles): g1-agents carries `send_personal_texts`, `build_claim_packet`,
  `create_appointment`, `move_appointment` with the probe's words. Closed by G1, not by S1 as Ruling BC planned
  (s1-storm still lists only demo/S1/E1 titles; it will take D1/G1 titles when it merges those tracks).

Still kept in the probe:
- Item 1 (D1 journal `when`): d1-front-desk 1c90be5 has 17 entries, 0019/0020 = 1791770789451/1791770804997 (no
  E1/S1 entries). A1's `a1-t4` raises them (1791772863000/1791772864000) but is not on any track head.
- Item 3 (Ruling BA recounts): `a1-dock`, `a1-settings`, `settings`, `d1-routes`, `d1-settings`, `e1-routes`,
  `setup`, `c1-routes` and `steps` tests still differ from every track head. Combined counts unchanged: six dock apps
  shipped (no Coming soon app), eleven settings tabs, fifteen step types; setup shows no "Coming with" line for the
  Estimator, calendar or Front Desk, and keeps Storm Scout's.
- Item 4 (409 on `POST /api/storms/:id/plan`): still probe-only. s1-storm `routes/storms.ts` has no 409 and
  `draftStormPlan` still returns `Promise<{ taskId }>`; S1 R2a has a brief but no branch yet.

Item 6 (Ruling BC storm-plan rerun), status:
- A1 T20: built on `a1-t20` 0f569ac (3 commits on a956d40: rerun keeps OFF steps off via `off: errorPlain`, a
  storm_plan rerun re-drafts through `draftStormPlan(..., { replaceFinished: true })` in `routes/approvals.ts`,
  `lockStormPlan(tx, ctx, id, opts)`, `STORM_PLAN_ERRORS`, `storm-rerun.test.ts`). Not merged into a1-agents.
- S1 R2a: brief only (`ops/sdd/s1/task-r2a-brief.md`); `REDRAFTABLE` is still `['draft']` on s1-storm.
- Not implemented in the probe.

### New cross-track problems

1. **S1 R2a x A1 T19/T20, storm re-draft (design overlap, not yet in code).** The R2a brief targets S1's
   `replaceDraftPlan` (still on s1-storm), but A1 T19 (in the probe and a1-agents) replaced it with
   `lockStormPlan` + `supersedeDraft` + `linkStormPlan`, and A1 T20 (`a1-t20`) already adds expired/declined
   replacement behind `opts.replaceFinished` (rerun only). R2a makes `draftStormPlan` replace `draft`, `expired` and
   `declined` for every caller. Merged naively, the probe gets two mechanisms for the same rule. Fix: R2a builds on
   A1's `lockStormPlan` (from a1-agents or this probe), widens its allowed old statuses to draft/expired/declined
   and `REDRAFTABLE` in `routes/storms.ts` to the same list; A1 T20 then drops `replaceFinished` (or keeps it as the
   only switch if the controller wants the route to stay draft-only). R2a item 1 (status-guarded decline) is
   already met by A1's `supersedeDraft`. Owner: S1 R2a with A1 T20; controller to pick which one lands first.

Merge-artifact fixes: none.

### Checks (after all merges)

`npm ci` clean (no package change); `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass,
lint pass, lint:css pass; vitest @roofline/web 1171 pass (126 files), @roofline/ui 172 pass, @roofline/shared 1292
pass, @roofline/send-gate 525 pass. The database, API, worker and e2e suites run only in CI.

### CI (pass 11)

Run 38249175211 on 319d36c, attempt 1: Platform (lint, typecheck, tests) success; E2E (Playwright) success; Hail
service (ruff, pytest) success; v1 (node:test) success. E1 T21's new e2e specs (estimator, homeowner, the four new
a11y scans, the phone proposal view, `seedFootprintFixture` in the reset) pass beside A1's, D1's and S1's specs, and
S1 I5 passes the database and API suites in combination. No fixes were needed after CI, so ci-check was not re-run.
(The local `ci-check` wrapper was stopped by its time limit; the run was followed through the Actions API until it
completed.)

## Pass 12

Base: pass 11 head 7aa860d. `git fetch origin` (2026-10-12): every head matched the request; c1-crm 5d2e3bd was
already merged and was skipped. Merged in order with `git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 5d2e3bdf8c302084c9e98490c93a1b9846438f27 | (already in the probe) | - |
| e1-estimator | a8df936573e00957a3efd2810ee9e469ac5f1faa | ae6f103 | 8 files |
| s1-storm | fd42bc43310c0189db643abd839dd98645c521bd | 773ab0f | none (snapshot rebuild, below) |
| d1-front-desk | 1f8dc5a2c5c2e5de79d80307b01a4985b195d8e5 | 45abb02 | 1 file |
| a1-agents | 7fd771b8136581746e2d99fea8240fe667e2f5a5 | 6760d8d | none (ops only) |
| g1-agents | f7c59d1fb65f5877bbdabfd54ca938f8a7821a89 | 8b61e47 | none (ops only) |

Probe-only commit: ca5b5fe (merge artifact, below).

What the tracks brought: E1 its whole-branch review fixes (signatures and sent prices immutable in the database,
Ruling EQ, in 0016 in place; money, exact-report billing capped at the approved max, signed-PDF sweep schedule,
signature PNG, per-status Estimator lists, measure window, homeowner page, config) and "E1 complete"; S1 R3 (ads stay
guarded after a lost enable or a failed check, Meta ad sets ACTIVE under a PAUSED campaign, USD only,
`ad_campaigns.paused_by` added to 0018 in place under Ruling AW) plus the Ruling BD notes; D1 Task 26 (Front Desk calls
and bookings on timelines, the calendar and Today); A1 and G1 ledgers and briefs only (A1: T4/T21 built on `a1-t4`,
Task 22 brief, Ruling BD and its amendment). No dependency or lockfile change.

### Conflict resolutions

e1-estimator:
- `messaging/dispatcher.ts` (shared file): E1's C-I4 rule for a parked `send_proposal` step (a held text that was
  blocked or failed puts the proposal back to draft and the step `needs_attention` with the reason) kept, written
  through A1's `completeParkedStep` (A1's one-writer rule forbids `finishParkedStep` outside the task service; E1's
  side called it directly). `finish` is typed from `completeParkedStep`. `settleUnsentProposal` writes no event.
- `jobs/worker.ts`, `test/jobs.test.ts`, `test/pgboss.test.ts`: both schedule sets (S1's four storm schedules and E1's
  `signed-pdf-sweep`, `*/15`); the header comment names both.
- `packages/db/src/system/index.ts`: both barrels (E1's `signed-pdf-fanout.ts` after S1's block).
- `packages/shared/src/proposals.ts`: E1's `US_STATE_CODES`/`isUsStateCode` plus the probe's `STORED_FILE_KINDS`
  (`signed_proposal_pdf`, `storm_photo`, `ad_image`).
- `test/exact-report-poll.test.ts` imports: both (`listTaskEvents` from A1, `proposalOptions` from E1).
- `packages/db/test/rls.test.ts`: the app_tenant table-privileges test treats `SELECT_INSERT_ONLY` (D1/A1) and E1's
  `proposal_signatures` (column-level UPDATE only, Ruling EQ) as no table-level UPDATE; E1's signature column test
  follows E1's tenant-table test, then S1's hail tests.

d1-front-desk:
- `apps/web/test/helpers.tsx` `SHELL_ROUTES`: both (S1's storm reads, D1's `conversations?filter=needs_attention`).

Checked by hand: `hooks/twilio.ts` (Ruling AV order), `tasks/handlers.ts`, `tasks/service.ts`, `steps.ts`,
`send-batch.ts`, `router.tsx`, `routes/storms.ts`, `storm/plan.ts`, `repos/storm-plans.ts` and `routes/approvals.ts`
unchanged this pass; `dispatcher.ts` is the only shared file that changed. No E1/S1/D1 code calls an A1 one-writer
function directly (grep; lint passes).

### Migration journal (Ruling AP) and Ruling AW

S1 R3 amended 0018 in place (`ALTER TABLE ad_campaigns ADD COLUMN paused_by text`, `ad_campaigns_paused_by_check`, and
`paused_by, updated_at` in app_system's column grant) and its snapshot. The probe's 0019-0024 snapshots were rebuilt on
the new 0018 with a three-way JSON merge (base: old 0018, theirs: new 0018; delta = the column and the check), keeping
each snapshot's `id`/`prevId` and key order (10 lines each). `drizzle-kit generate --name=probe_check`: "No schema
changes, nothing to migrate"; no file created. Script: idx 0..24 consecutive and in number order, `when` strictly
increasing, `prevId` chained 0000..0024; 25 snapshots, 25 SQL files. Exactly one `messages (company_id, id)` unique,
D1's `messages_company_id_id_uniq`. E1's 0016 edit (Ruling EQ grants) changes no snapshot.

`storms.merged_into` (S1 R1): still NOT on s1-storm fd42bc4; only on the unmerged `s1-r1` 6d503ab. Not rebuilt.

Post-0018 snapshots that now disagree with S1's 0018 (no `ad_campaigns.paused_by`), checked per file:
a1-agents 0021/0022 (owner A1, at its next s1-storm merge), g1-agents 0019-0024 (owner G1), `a1-t4` 0019-0022 (A1).
d1-front-desk's 0019/0020 still chain from 0014 (no S1); D1 rebuilds when it merges s1-storm. Each must rebuild
after 0018 so drizzle-kit reports no changes on its own branch; R1's `merged_into` will need the same again.

### Earlier workarounds: status

Closed by a track this pass: none.

Still kept in the probe:
- Item 1 (D1 journal `when`): d1-front-desk 1f8dc5a still has 0019/0020 = 1791770789451/1791770804997 (17 entries).
- Item 2 (Ruling BA recounts): `a1-dock`, `a1-settings`, `settings`, `d1-routes`, `d1-settings`, `e1-routes`, `setup`,
  `c1-routes` and `steps` tests still differ from every track head. Combined counts unchanged: six dock apps shipped,
  eleven settings tabs, fifteen step types.
- Item 3 (409 on `POST /api/storms/:id/plan`): probe-only. s1-storm `routes/storms.ts` has no paused 409 and
  `draftStormPlan` on s1-storm still returns `Promise<{ taskId }>`; S1 R2a (`s1-r2a` aa9f2af) is not merged.
- Item 4 (Ruling BC/BD storm-plan rerun and re-draft, A1 T20): not on a1-agents. `a1-t20` 5590993 builds on
  `lockStormPlan`/`supersedeDraft`/`linkStormPlan` and widens re-draft to draft/expired/declined, but for every caller
  with no `allowFinished`: that is the pre-amendment Ruling BD. A1's ledger says the amendment (automatic path drafts
  only over drafts; `allowFinished` set only by the rerun route) is applied after T20's current run. The probe keeps
  `REDRAFTABLE = ['draft']` and no rerun branch.

Ruling BD: no track head carries two re-draft mechanisms (s1-storm has only its old `replaceDraftPlan`, which the probe
replaces with A1's code, as since pass 10). Watch item: the unmerged `s1-r2a` aa9f2af still widens
`replaceDraftPlan` and adds `REDRAFTABLE_PLAN_STATUSES` in `storm/plan-errors.ts` and `routes/storms.ts`; per Ruling BD
the S1 lead must drop those at merge (S1 ledger plans exactly that).

### New cross-track problems

1. **E1 x A1, dispatcher one-writer.** E1's review (C-I4) calls `finishParkedStep` directly in
   `messaging/dispatcher.ts` with a `needs_attention` finish; with A1 that bypasses `recordOutcome` (no step event) and
   breaks A1's one-writer lint. Probe fix: route it through `completeParkedStep(tx, ctx, step.id, finish, now)`.
   Owner: A1 at its next e1-estimator merge (the merge rule above). Database/API effect is verified by CI.
2. **S1 R3 x A1/G1/D1, 0018 snapshot (Ruling AW).** See the list above; owners A1, G1, D1.

Merge-artifact fixes (ca5b5fe): S1's `s1-routes` "dock Storm opens /storm" test starts at `/estimator` and stubbed
only `GET /api/proposals`; E1's review made the Estimator read one URL per status, so the test saw five unexpected
calls. It now spreads E1's `proposalListRoutes()`.

### Checks (after all merges and the probe commit)

`npm ci` clean (no package change); `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass, lint
pass, lint:css pass; vitest @roofline/web 1213 pass (133 files, after ca5b5fe), @roofline/ui 172 pass,
@roofline/shared 1296 pass, @roofline/send-gate 525 pass. The database, API, worker and e2e suites run only in CI.

### CI (pass 12)

Run 38257556433 on a7e2b55, attempt 1: E2E (Playwright) success; Hail service success; v1 success; Platform failure,
16 tests in 4 API files, all from E1's review meeting S1's tests (merge artifacts, test-only):
- `test/pgboss.test.ts`: the schedule list is sorted by name; the merge put `signed-pdf-sweep` after S1's
  `spotter-sync`/`storm-match`. Moved it into name order.
- `test/storm-config.test.ts`, `test/google-ads-http.test.ts`, `test/postmark-broadcast.test.ts`: E1's review (Ruling
  ET) makes the four R2 settings required in production (`config.ts` superRefine) and adds them to E1's own production
  fixtures; these S1-only files build a production config without them and threw `ConfigError`. They now carry the
  same four settings (E1's comment and values). Owner of the real change: S1, at its next e1-estimator merge (new
  cross-track problem 3).

Fix commit 88a4d2b. Run 38260235945 on 88a4d2b, attempt 1: Platform (lint, typecheck, tests) success; E2E (Playwright)
success; Hail service (ruff, pytest) success; v1 (node:test) success. E1's review fixes (immutable signatures, the
signed-PDF sweep, C-I4 through A1's `completeParkedStep`), S1 R3 (`paused_by`, ad guards) on the rebuilt 0019-0024
snapshots and D1 T26 pass the database, API, worker and e2e suites in combination. (The local `ci-check` wrapper was
stopped by its time limit; both runs were followed through the Actions API until they completed.)

New cross-track problem 3. **E1 x S1, production config fixtures.** E1's Ruling ET requires R2 in production; S1's
three config-building tests above lack it and fail only in combination. Fix: add `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` to their production `VALID`. Owner: S1 when it merges
e1-estimator (any later S1 test that builds a production config needs the same).

## Pass 13

Base: pass 12 head ab09bae5. `git fetch origin` (2026-10-12): every head matched the request. Merged in order with
`git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 7758e82157918218b8b87e6237772874e2154469 | 2457931 | 4 files |
| e1-estimator | 08da8321c31e17ce79c09b7d6666ed7255448227 | 5f93bfb | 1 file |
| s1-storm | d07a440e7544021edfe9c6ea6afedb08145cee54 | dfc726b | 6 files + snapshot rebuild |
| d1-front-desk | 6600b5cbec0fbd1aeb56a9a780bf051adcf3ed9e | b293550 | 21 files |
| a1-agents | f48086c72df56af27b8ff910e04eaddde43d215c | f93ad30 | 1 file |
| g1-agents | e9834cd980eda7e4ed1cce079b4759845bd555c5 | cddd1c2 | none (docs only) |

Probe-only commits: ad3191c and 94c62b1 (cross-track fixes, below).

What the tracks brought: C1 the security fixes (Ruling BF / SEC-1..4: TRUST_PROXY required in production, login and
invite limits, `__Host-rl_session`, late errors, exact app_system grants in 0002 and a no-TRUNCATE/TRIGGER/REFERENCES
test); E1 its security findings (0016 footprint grants exact) and c1; S1 T28 (storm e2e specs, a11y, phone), R1
(`storms.merged_into`, 0018 in place), R2a/R2b with the Ruling BD trim, R4, R5, R7 and the NOT_USD fixture fix; D1
Tasks 4-6 and 10-18 (voice hooks, relay, Front Desk texts, conversations, calls, recordings, retention, setup phone
step real) and Ruling BF (0020 conversation_turns grants); A1 T20 (rerun; storm plans re-draft per amended Ruling BD,
`allowFinished`); G1 docs only (g1-md4/g1-full are not merged into g1-agents yet). No dependency or lockfile change.

### Conflict resolutions

c1-crm: `config.ts` both (E1 EagleView/R2/proposal-origin, S1 ads/meta checks, C1 TRUST_PROXY); `geocodio.test.ts` and
`microsoft-calendar.test.ts` production fixtures carry both R2 and TRUST_PROXY; `rls.test.ts` both (E1/S1 grant tests
then C1's no-TRUNCATE test).

e1-estimator: `config.ts` keeps S1's Google Ads/Meta checks (E1's side is C1's TRUST_PROXY check, already present).

s1-storm:
- `storm/plan.ts` (shared): A1's mechanism kept (pause check, `lockStormPlan`/`supersedeDraft`/`linkStormPlan`), with
  S1's `plan-errors.ts` constants and S1 R2a's "a re-draft of a draft sends no second ready email"
  (`fresh: !previousWasDraft`). S1's `replaceDraftPlan` does not come back.
- `routes/storms.ts`: S1's side (`?since=`, `PLAN_*` constants, 409 `PLAN_PAUSED`).
- `test/storm-plan.test.ts`: S1's `draft()` and its R2a tests, plus A1's "one declined system event" test; the old
  mixed "never replaces an approved or running plan" test is S1's `test.each` now.
- e2e `a11y.spec.ts`, `phone.spec.ts`: both (A1 agents screens, E1 estimator imports, S1 storm screens);
  `fixtures.ts`: imports from both, `resetScenario` seeds the showcase, E1's footprint fixture and S1's storm fixture.

d1-front-desk: resolved by applying G1's own resolution of the same merge (`g1-md4` 5c03479 = g1-agents ea5f097 + D1
4ce5c7f) onto the probe side with `git merge-file` (base ea5f097, theirs g1-md4); the remainder by hand:
- `providers/object-store.ts`, `fakes/object-store.ts`, `r2.ts` (add/add): E1's store plus D1's `signedGetUrl`/`delete`
  (Ruling DV), as g1-md4.
- `app.ts`, `deps.ts`: D1's deps, voice hooks and routes added to the probe's; CSP unchanged.
- `hooks/twilio.ts` (Ruling AV): STOP/HELP/START, then S1 `onStormReply`, then D1 `queueFrontDeskText`; G1's claims
  call is not on g1-agents yet.
- `config.ts`: D1's Front Desk settings with C1's TRUST_PROXY comment; the transform carries D1's relay values and
  S1/E1's defaults. `config.test.ts` expects D1's values with C1's `TRUST_PROXY: 1`; `helpers.ts` both.
- `jobs/handlers.ts`, `worker.ts`, `queue.ts` (`SendOptions` with E1's per-job expiry), `jobs.test.ts`,
  `pgboss.test.ts`: both schedule sets; `signed-pdf-sweep` stays in name order in the sorted list.
- `index.ts`, `packages/db/src/index.ts`, `system/index.ts`: both barrels, E1 skeleton lines once.
- setup (`repos/setup.ts`, `shared/setup.ts`, tests), `rls.test.ts` (D1 Ruling BF): D1's.
Every resolved file was diffed against g1-md4: the only differences are newer C1/E1/S1 content.

a1-agents: `storm/plan.ts` takes A1 T20's `draftStormPlan` (opts `allowFinished`, `rerunOfTaskId`, `createdByUserId`,
`afterCreate`), keeps S1 R2a's `fresh: !previousWasDraft`, and `STORM_PLAN_ERRORS` is defined from `plan-errors.ts`
(one set of strings). Per A1's merge rule (a), S1's `REDRAFTABLE_PLAN_STATUSES` is deleted from `storm/plan-errors.ts`
and `routes/storms.ts` imports the db one (`['draft']`).

Checked by hand: `dispatcher.ts` still calls `completeParkedStep` (item 5); `tasks/handlers.ts`, `tasks/service.ts`,
`steps.ts`, `send-batch.ts`, the router and `routes/approvals.ts` merged clean; `routes/approvals.ts` (rerun) is the only
caller with `allowFinished`.

### Migration journal (Ruling AP) and Ruling AW

S1 R1 amended 0018 in place (`storms.merged_into uuid REFERENCES storms(id)`, `GRANT UPDATE (merged_into)` to app_hail)
and its snapshot. The probe's 0019-0024 snapshots were rebuilt on the new 0018 with a three-way JSON merge (base: old
0018, theirs: new 0018; delta = the column and `storms_merged_into_storms_id_fk`), keeping each `id`/`prevId` and key
order (22 lines each, the same as S1's 0018 diff). D1's 0020 edit (Ruling BF) and E1's 0016 edit change no snapshot.
`drizzle-kit generate --name=probe_check`: "No schema changes, nothing to migrate"; no file created. Script: idx
0..24 consecutive and in number order, `when` strictly increasing, `prevId` chained 0000..0024; 25 snapshots, 25 SQL
files. Exactly one `messages (company_id, id)` unique, D1's `messages_company_id_id_uniq`.

R8 (Ruling BF: global unique index on `ad_accounts (platform, external_account_id)` where not revoked, grant trims) is
NOT on s1-storm d07a440 (R8-R10 are briefs; only the fixture side 3f800e5 landed). Not rebuilt.

Post-0018 snapshots that disagree with S1's 0018 (neither `ad_campaigns.paused_by` nor `storms.merged_into`), checked
per file: a1-agents 0021/0022 and `a1-t4` 0019-0022 (owner A1), g1-agents, `g1-md4` and `g1-full` 0019-0024 (owner G1;
`ops/sdd/g1/snapshot-delta.py` is G1's tool for it), d1-front-desk 0019/0020 (owner D1; still chained from 0014, no S1).
A1 and G1 have not rebuilt: neither has merged s1-storm since R1/R3.

### Items: status

Closed by a track this pass: none fully.
- Item 3 (409 on `POST /api/storms/:id/plan`): now carried by S1 (R2a 28f3800, trim 41b970c): `draftStormPlan`
  returns `{ taskId } | null`, the route answers 409 `PLAN_PAUSED`, `REDRAFTABLE_PLAN_STATUSES = ['draft']`,
  `replaceDraftPlan` back to T11's form. The probe takes S1's route; its probe-only 409 is gone. With A1's
  `isAgentPaused` check in `draftStormPlan` the 409 is reachable. The probe has one re-draft mechanism (A1's); S1's
  `replaceDraftPlan` is not in the probe. Open part: S1's duplicate `REDRAFTABLE_PLAN_STATUSES` in `plan-errors.ts` (A1
  carry (a)); the probe deletes it.
- Item 4 (A1 T20 under amended Ruling BD): carried by a1-agents (181e4d7): automatic paths (storm-match, storm-draft job,
  plain `draftStormPlan`) re-draft only over drafts; `allowFinished` is passed only by `routes/approvals.ts` (rerun).
  Closed in code. Open as a ruling question (new problem 5).

Still open (probe keeps its workaround):
- Item 1: d1-front-desk 6600b5c still has 0019/0020 `when` = 1791770789451/1791770804997, below S1's 0018
  (1791772862263), and its 0019 snapshot chains from 0014. Owner D1 at its s1-storm merge.
- Item 2: the `a1-dock`, `a1-settings`, `settings`, `d1-routes`, `d1-settings`, `e1-routes`, `c1-routes`, `setup`
  (web and shared) and `steps` tests still differ from every track head. Web tests pass on the combined set (1243).
- Item 5: e1-estimator still calls `finishParkedStep` twice in `dispatcher.ts`; a1-agents has not merged e1 since.
  The probe keeps `completeParkedStep`. Owner A1.
- Item 6: s1-storm has not merged e1-estimator: its storm-config, google-ads-http and postmark-broadcast production
  fixtures still lack R2 (and now TRUST_PROXY, below), and `s1-routes` still lacks `proposalListRoutes()`. Owner S1.
- Item 7: R1 rebuilt this pass; R3 rebuilt in pass 12; R8 not on s1-storm. Tracks behind: A1, G1, D1 (list above).
- Item 8: S1 R9/R10 are not merged. R5 moved the storm form's rate limit and Origin guard inside
  `stormRequestRoutes`; T28 sends `Referrer-Policy: same-origin` on the storm page. No clash with D1/C1/E1 public
  routes or the CSP yet.

### New cross-track problems

1. **C1 x S1, 0018 `GRANT ALL ON spotter_reports TO app_system`.** C1's new rls test (no TRUNCATE, TRIGGER or REFERENCES
   for app_system on any relation) fails on it, and S1's own test pins `truncate: true`. Probe fix (ad3191c): 0018 grants
   SELECT, INSERT, UPDATE, DELETE; the S1 test expects no TRUNCATE. Owner S1 at its c1 merge (Ruling AW, in place); the
   loader itself needs only SELECT and INSERT (`insert .. on conflict do nothing returning id`).
2. **C1 x D1, `company_phone_numbers` UPDATE.** C1 SEC-4 leaves app_system SELECT, INSERT on `company_phone_numbers`;
   D1's `markVoiceUrlSet` (`system/voice-routing.ts`, called by the fd-health job) updates `capabilities` through the
   system pool, so `apps/api/test/front-desk/number-voice.test.ts` and the fd-health job fail with permission denied.
   Probe fix: 0020 adds `GRANT UPDATE (capabilities, updated_at) ON company_phone_numbers TO app_system` (Drizzle's
   `$onUpdate` also writes `updated_at`; `capabilities` alone still failed in CI, fixed in 94c62b1). Owner D1 at its c1
   merge (C1's merge note: grant what you need in your own migration).
3. **C1 x S1, production config fixtures need TRUST_PROXY.** S1's storm-config, google-ads-http and postmark-broadcast
   tests build a production config without it and throw `ConfigError`. Probe fix: `TRUST_PROXY: '1'` (with the R2 four
   from pass 12). Owner S1 at its c1/e1 merge.
4. **C1 x E1, late-error log leaks the proposal token.** C1's new `res.headersSent` branch in `errors.ts` logs the raw
   `req.path`; E1's `pathForLog` scrubs `/public/proposals/<token>`. The same code is on c1-crm and e1-estimator. Probe
   fix: `logError(err, pathForLog(req.path))`. Owner E1 lead (sec-core).
5. **Ruling BD wording (A1 x S1), "Draft a new plan".** A1's merge rule (b) and the comments in `storm/plan.ts`,
   `storm/settle.ts` and `repos/storm-plans.ts` say S1's `POST /api/storms/:id/plan` should also pass `allowFinished`
   (expired/declined -> 200 with a new draft); the amended Ruling BD says only the rerun route passes it. S1's R4 web
   shows a Redraft button on expired/declined plans, which the route answers 409 `PLAN_EXISTS`. The probe follows the
   ruling (storms route: drafts only, no `allowFinished`). Owner: controller decides; then S1 (route + web) or A1
   (comments).
6. **D1 x E1, recording playback blocked by the CSP.** With E1's R2 store, D1's `GET /api/calls/:id/recording` hands
   the browser a presigned `https://<account>.r2.cloudflarestorage.com/...` URL for `<audio>` (`RecordingPlayer.tsx`),
   but `app.ts`'s CSP has no `media-src`, so it falls back to `default-src 'self'` and production playback is blocked
   (tests and e2e use the memory store, so nothing fails). Fix: add `mediaSrc: ["'self'", <the R2 origin from
   R2_ACCOUNT_ID>]` (or proxy playback through the API). Owner D1 (Ruling DV), with E1 for `r2.ts`. Not changed in
   the probe.
7. **S1 R2a x A1 T20, plan-ready email on re-draft.** A1's `draftStormPlan` returns `fresh: true` for every new draft,
   which drops S1 R2a's "a re-draft of a draft sends no second ready email" (S1 test in `storm-plan.test.ts`). The probe
   keeps S1's rule inside A1's code (`fresh: !previousWasDraft`; a rerun over an expired/declined plan still emails).
   Owner A1 at its s1 merge.

### Checks (after all merges and ad3191c)

`npm ci` clean (no package change); `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass, lint
pass, lint:css pass; vitest @roofline/web 1243 pass (133 files), @roofline/ui 172 pass, @roofline/shared 1298 pass,
@roofline/send-gate 532 pass. The database, API, worker and e2e suites run only in CI.

### CI (pass 13)

Run 38271112763 on f47286c, attempt 1: E2E (Playwright) success; Hail service success; v1 success; Platform failure,
8 tests in 3 API files:
- `test/front-desk/number-voice.test.ts` (6) and `test/front-desk/settings-routes.test.ts` "first save sets voice url"
  (1): `markVoiceUrlSet` still refused. `timestamps()` gives `updated_at` a Drizzle `$onUpdate`, so the update also
  writes `updated_at`; the 0020 grant is now `UPDATE (capabilities, updated_at)` (new problem 2).
- `test/exact-report.test.ts` "an expired price within the approved max is re-priced then ordered" (1): not a merge
  artifact. The test helpers build `FakeExactReports()` on the wall clock (`expiresAt` = real now + 10 min) while the
  test clock is pinned to 2026-10-12T15:00Z, so after 15:01Z real time the price is never expired at test time + 11 min.
  It passed in pass 12 only because that run was earlier in the day; it fails the same way on e1-estimator and every
  branch carrying E1 from now on. Probe fix: `new FakeExactReports(() => clock.now())` in `test/helpers.ts`.

Fix commit 94c62b1. Run 38275182476 on 94c62b1, attempt 1: Platform (lint, typecheck, tests) success; E2E (Playwright)
success; Hail service (ruff, pytest) success; v1 (node:test) success. C1's security fixes, E1's security findings, S1
T28/R1/R2a/R2b/R4/R5/R7 on the rebuilt 0019-0024 snapshots, D1 Tasks 4-6 and 10-18 and A1 T20 pass the database, API,
worker and e2e suites in combination. (The local `ci-check` wrapper was stopped by its time limit; both runs were
followed through the Actions API until they completed.)

New problem 8. **E1 test time bomb, `FakeExactReports` on the wall clock.** See above. Fix:
`new FakeExactReports(() => clock.now())` in `apps/api/test/helpers.ts` (`makeTestApp`). Owner E1, now (it is red on
e1-estimator and on every track that carries E1 after 2026-10-12T15:01Z).

## Pass 14

Base: pass 13 head 431ea771. `git fetch origin` (2026-10-12): every head matched the request; c1-crm 7758e82 was already
merged and was skipped. Merged in order with `git merge --no-ff`:

| Track | Head merged | Merge commit | Conflicts |
|---|---|---|---|
| c1-crm | 7758e82157918218b8b87e6237772874e2154469 | (already in the probe) | - |
| e1-estimator | be4793d5e3a11a172c88b21f49898bd263dce86c | ae33581 | 2 files |
| s1-storm | 19963e0e880630ddc2b996f330fc742ba4d331aa | c9bd8df | 12 files + snapshot rebuild |
| d1-front-desk | 93dcfca869e2dc0085363f280ab66bdc7e80ed3e | c22d5d1 | 10 files |
| a1-agents | 50295ebdf6ea564c449d4d2c41c2db676e3332cc | 7b9d3f3 | 30 files (A1's own resolution of D1 4ce5c7f vs the probe's) |
| g1-agents | bbf8e5dcb2e4e3d7ab1cca1be5751b5730c40473 | d746f37 | 30 files (all of G1 lands: g1-full, g1-md4, T8c, T18b) |

Probe-only commits: 6d5c496 (Ruling BD final, A1's a1-merge-up2 files), 546e745 (`ops/bin/launch-normalize` and
`packages/db/scripts/launch-normalize{,-lib}.ts` from `ops-launch-prep` c3ce947; its docs and db test not taken),
ed3d962 (merge artifacts and cross-track fixes, below).

What the tracks brought: E1 the dispatcher through `completeParkedStep` for the parked end (Ruling AX-H), `pathForLog`
in the late-error branch, the FakeExactReports test clock, the signed-PDF signature fix; S1 R8-R10 (Ruling BF: ad account
unique index, grant trims in 0018 in place, public forms hardening, storm form YES) and its c1/e1 security re-merge (R2 and
TRUST_PROXY in its production fixtures, `proposalListRoutes()` in s1-routes); D1 T7-T9, T19, T27, d1-sec and its c1 sync
(0020 `GRANT UPDATE (capabilities, updated_at)`), `daily` weather; A1 T4/T21/T22 (Front Desk live tasks, rules, follow-ups,
`setStepResult`/`insertTask` added to the one-writer rule); G1 every task (Claims, Scheduler, Follow-up, claim packet,
agent values, claims replies in the inbound hook, 0023 `claim_packet` stored-file kind).

### Conflict resolutions

e1-estimator: `dispatcher.ts` E1's comment, the probe keeps `completeParkedStep` for the `running` re-save too (E1 still
imports `finishParkedStep` for it; A1's a1-merge-up2 has the probe's form); `test/helpers.ts` E1's FakeExactReports line.
`errors.ts` merged clean (E1's `pathForLog` replaces the probe copy).

s1-storm: 0018, `storm-config`/`google-ads-http`/`postmark-broadcast` tests: S1's (drops the probe's pass-13 0018 grant
edit and fixture comments). `hooks/twilio.ts` (Ruling AV): both imports; `onStormFormYes` then `onStormReply`, then G1,
then Front Desk. `worker.ts`, `jobs.test.ts`, `pgboss.test.ts`, `system/index.ts`, `fixtures.ts`: both sides. `rls.test.ts`:
S1's spotter_reports SELECT/INSERT test, the EQ signature test once, D1's column rows with S1's `company_storms` trim
(`id, company_id, status`).

d1-front-desk: `weather/source.ts`, `nws.ts`, `weather.test.ts`, `test/helpers.ts` keep G1's `hourly` and D1's `daily`
(the interface has both; FakeWeatherSource has both real methods); 0020 D1's (drops the probe copy); `copy/today.ts` both;
e2e `stack.ts`/`fixtures.ts` D1's `ENCRYPTION_KEY`/`testCallerNumber`; `a11y.spec.ts`/`phone.spec.ts` both.

a1-agents: A1's merge commits only re-resolve D1 4ce5c7f (checked with `git show --cc`: no A1-only change in those files);
every conflicted file took the probe side except A1's own: `db/src/index.ts` (probe barrel + A1's new exports),
`front-desk/texts.test.ts` (both imports), `copy/agents.ts` (A1's "(incl. bookings)" labels plus G1 keys), `test/helpers.ts`.
Artifact: the merge dropped `import type { ObjectStore }` from `app.ts` (restored in the merge).

g1-agents: barrels, `deps.ts`, `app.ts` (G1 routes and `staticMap`), `queue.ts`, `handlers.ts`, `worker.ts`, jobs/pgboss
tests, `proposals.ts` (`claim_packet`), `copy/agents.ts`, e2e specs, `a1-dock`, `a1-routes`, `a1-settings`: both sides.
`hooks/twilio.ts`: G1's claims call between S1 and Front Desk (Ruling AV). Cross-track (new problems 1-3):
`agents/run-now.ts`, `agents/metrics.ts`, `routes/agents-settings.ts`, `agents/rule-facts.ts` (+ test), `AgentsTab.tsx`,
`AgentPage.tsx`, `RunNowButton.tsx`.

Ruling BD (final): `storm/plan.ts`, `storm/plan-errors.ts`, `routes/storms.ts`, `routes/approvals.ts`, `storm-plan.test.ts`,
`storm-routes.test.ts` taken from A1's `a1-merge-up2` 6e20e90 (diffed: their only differences from the probe are the BD
hunks). `POST /api/storms/:id/plan` passes `allowFinished` and the person as `createdByUserId`; rerun passes it; the
automatic paths do not; `fresh: lock.oldDraftId === null` (lockStormPlan sets `oldDraftId` only for a draft, so it equals
`!previousWasDraft`); one REDRAFTABLE pair in `@roofline/db`. s1-storm's StormDetail keeps "Draft a new plan" on expired
and declined plans (no red item).

### Migration journal (Ruling AP) and Rulings AW/BF

S1 R8 amended 0018 in place (`ad_accounts_platform_external_live_uq`, grant trims) and its snapshot. The probe's
0019-0024 snapshots were rebuilt on it with a three-way JSON merge (base: old 0018, theirs: new 0018; delta = the index;
`id`/`prevId` and key order kept; 25 lines each, as S1's). G1's 0023 adds the `claim_packet` kind (SQL and 0023/0024
snapshots, merged clean). `drizzle-kit generate`: no changes. `ops/bin/launch-normalize --check`: journal OK (25, `when`
increasing), snapshots OK (25 chained), drizzle-kit OK, grants FAIL on one item: app_system
`GRANT UPDATE (recording_key, recording_status) ON calls` (0020) lacks `updated_at` (D1 item in progress on d1-rev-d: D1
says nothing writes `calls` as app_system, so the grant is dropped or gets updated_at; not patched in the probe). Exactly one
`messages (company_id, id)` unique, D1's.

Post-0018 snapshots that disagree with S1's 0018: a1-agents 0021/0022 (no merged_into, ad_campaigns.paused_by, R8),
a1-merge-up2 0019-0022 (no R8), g1-agents 0019-0024 (none of R1/R3/R8), g1-ms2m and g1-me2m 0019-0024 (no R8),
d1-front-desk 0019/0020 (chained from 0014, no S1).

### Items: status

Closed by a track this pass:
- Item 4 (S1): R8 0018 (spotter_reports SELECT, INSERT), TRUST_PROXY/R2 in the three production fixtures,
  `proposalListRoutes()` in s1-routes: taken from S1, probe edits gone.
- Item 5 (E1): clock fix and `pathForLog` taken from E1, probe copies gone.
- Item 6 (D1 0020 grant): taken from D1.
- Ruling BD: closed in code (A1's version); route and rerun pass `allowFinished`, automatic paths do not.

Still open:
- Item 1: d1-front-desk 93dcfca still has 17 journal entries; 0019/0020 `when` below S1's 0018 and 0019 chained from 0014.
- Item 2: a1-dock, a1-settings, settings, e1-routes, steps and now a1-routes and g1-turn-on differ from every head (each
  within a few lines of g1-agents). Combined: six dock apps shipped, every G1 agent launched.
- Item 3: e1 still calls `finishParkedStep` for the `running` re-save (owner A1 at its e1 merge; a1-merge-up2 has it);
  the db REDRAFTABLE pair and `fresh` are in a1-merge-up2 only; the post-0018 snapshot rebuild is not on a1-agents.
- Item 6b: D1 Task RA (recording CSP) not landed: `app.ts` has no `media-src`; D1's ledger says RA proxies playback and
  sets `media-src 'self'`.
- Item 7: list above.

### New cross-track problems

1. **G1 x A1, one-writer rule.** G1's `agents/notes.ts` and `routes/claims.ts` import `moveStep`/`updateTask` (A1's
   eslint EVENT_WRITERS; g1-agents' eslint has no such rule). Lint fails in combination. Probe: block-scoped
   `eslint-disable no-restricted-imports` on those imports. Fix: G1 creates those tasks through A1's task service
   (`createLiveTask`/an approve-style service function) so the status moves write events. Owner G1 at its a1 merge.
2. **G1 x A1, Run now after commit.** A1 made `RUN_NOW` handlers `(ctx, deps)` run after the transaction commits
   (`runAgentNow` returns `{ result, send }`); G1's handlers are `(tx, ctx, jobs)` run inside. Probe: A1's shape, G1's
   three handlers converted, G1's paused 409 and `G1_AGENTS_SHIPPED` kept, Storm Scout paused check kept. Owner G1.
3. **G1 x A1, Agents screen and facts.** `metrics.ts` `statusOf(agent, settings, waitingCount)` uses A1's Front Desk
   waiting count; `rule-facts.ts` returns A1's Storm Scout/Front Desk facts plus G1's three (A1's exact-equality test
   now compares `stormScout` only; G1's default test uses `toMatchObject`); Settings Agents tab shows A1's
   `TimeBaselines` then G1's `AgentRules` (G1 had replaced A1's slot); `AgentPage` keeps G1's claims board and Run-now
   hiding with A1's `paused` prop; `RunNowButton` A1's company-time label with G1's labels; G1's `g1-turn-on` test stubs
   time-baselines; A1's "/agents/claims coming soon" test removed (claims ships). Owner G1 at its a1 merge.
4. **S1 x A1/G1/D1 snapshots (Ruling AW).** List above.

Merge-artifact fixes: `app.ts` ObjectStore import (a1 merge); `deps.ts` `UnconfiguredLlm` G1 stub bodies (ed3d962);
`a1-routes` unused import.

### Checks (after all merges and ed3d962)

`npm ci` clean (no lockfile change); `npm ls playwright-core` only 1.56.1. Through `ops/bin/slot`: typecheck pass (incl.
`tsc -p scripts`), lint pass, lint:css pass; vitest @roofline/web 1316 pass (142 files), @roofline/ui 172 pass,
@roofline/shared 1361 pass, @roofline/send-gate 532 pass. `ops/bin/launch-normalize --check`: fails only on the D1
`calls` grant (above). The database, API, worker and e2e suites run only in CI.

### CI (pass 14)

Run 38282615492 on 44b263f, attempt 1: Hail service success; v1 success; E2E failure (4 tests); Platform failure (3 tests
in 1 file), all from the combination, none a flake:
- `e2e/agents-settings.spec.ts` (2, A1): the Settings Agents tab now holds A1's time-saved table and G1's agent rules form,
  each with a "Save" button, so `getByRole('button', { name: 'Save', exact: true })` matched two. Now `.first()` (the
  table's comes first).
- `e2e/agents.spec.ts` "the G1 agents say Coming soon" (A1): G1 ships its agents (`G1_AGENTS_SHIPPED`), so the cards
  say Paused and Turn on. Rewritten to that (Ruling BA, combined set).
- `e2e/more-agents.spec.ts` (G1): A1's card link is labelled by name, chip and time line (`aria-labelledby`), so
  `getByRole('link', { name: 'Claims', exact: true })` found nothing. The card is found by its heading, as A1's spec does.
- `test/smoke-front-desk-guards.test.ts` (3, D1 T27): its production `BASE_ENV` lacks R2 (E1 Ruling ET) and TRUST_PROXY
  (C1 security finding 4), so `loadConfig` throws before the guards. Added both (new problem 5).

Fix commit 2a3cbe5. Run 38286869957 on 2a3cbe5, attempt 1: Platform (lint, typecheck, tests) success; E2E (Playwright)
success; Hail service (ruff, pytest) success; v1 (node:test) success. All six tracks (G1 complete, D1 T19/T27, A1
T4/T21/T22, S1 R8-R10, E1 sec fixes) and final Ruling BD pass the database, API, worker and e2e suites in combination.
(The local `ci-check` wrapper was stopped by its time limit; both runs were followed through the Actions API.)

New problem 5. **D1 x C1/E1, Front Desk smoke production fixture.** `apps/api/test/smoke-front-desk-guards.test.ts`
`BASE_ENV` needs `TRUST_PROXY: '1'` (C1, already on d1-front-desk since c49523a, so this part is red on D1 itself) and
the four R2 settings (E1, at D1's e1 merge). Owner D1.
New problem 6. **A1 x G1, Agents e2e.** The three spec fixes above belong in A1 (agents, agents-settings) and G1
(more-agents) at their next merge of each other. Owners A1 and G1.
