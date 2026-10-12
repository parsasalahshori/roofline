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
