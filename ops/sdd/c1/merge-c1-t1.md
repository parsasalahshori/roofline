minor [1,3]: T1 defines its own `WeekdayKey`, `WeeklyHours` and a private `DEFAULT_WORK_HOURS` in packages/db/src/schema/tenant.ts and uses them to type `company_settings.work_hours` and `member_schedules.weekly_hours`. The shapes match what T3 adds to @roofline/shared (`Weekday`, `WorkHours`, `DEFAULT_WORK_HOURS`, from the c1-t3 branch and plan lines 226-227). @roofline/db also exports `WeeklyHours` and `WeekdayKey` through schema/index.ts. So once T3 lands there are two type names for the same thing, plus a second copy of the default hours. They compile together because the types are structurally identical, but they can drift apart, and repos written later (T8/T9 `memberHours`/`saveMemberHours`, `ScheduleSettings`) may import either name.
 -> Keep T1 as it is for this merge. After T3 merges into c1-crm, make a small follow-up: type both jsonb columns with `$type<WorkHours>()` and default `work_hours` to the shared `DEFAULT_WORK_HOURS`. The values are identical, so drizzle-kit generates no new migration; confirm with `drizzle-kit generate` and expect no diff. Then delete the local `WeekdayKey`, `WeeklyHours` and `DEFAULT_WORK_HOURS`, or turn them into aliases if something already imports them. Until then, tell T8/T9 to import `WorkHours` from @roofline/shared and not `WeeklyHours` from @roofline/db.

minor [1]: Migration 0013 also contains `CREATE UNIQUE INDEX texting_registrations_messaging_service_sid_uniq ... WHERE messaging_service_sid is not null`, which is not in the Task 1 brief. It is the parked F3 index, assigned to C1 T1 by Ruling AO in f3/progress.md and c1/progress.md, so it is intended. But on any database that already has two registrations with the same non-null SID, 0013 fails as a whole, and the CRM tables would not be created either.
 -> No code change needed for CI or a fresh database. Before applying 0013 to any long-lived database (staging or showcase), run `select messaging_service_sid, count(*) from texting_registrations where messaging_service_sid is not null group by 1 having count(*) > 1` and clean up any duplicates first.

Task 1 (c1-t1 @ 2105d50, base bdc0f9f) into c1-crm (origin/c1-crm is now 52d2ee6, which is bdc0f9f plus later F3 merges: T24 import, T25 Twilio accounts, T29 UI kit, T30 web skeleton, P3b billing polish).

Conflict prediction:
- `git merge-tree --write-tree origin/c1-crm 2105d50` is clean (tree f31eecbb).
- The two sides change no file in common. The F3 range touches no migrations, no packages/db/src/schema, no package-lock.json or package.json, and none of the barrels.
- packages/db/migrations still ends at 0012_early_reports_prune on c1-crm, so 0013_crm_schema and 0014_crm_grants_rls (journal idx 13 and 14) do not collide.
- Merge with `--no-ff` as usual.

Checks against the brief and global constraints, all OK:
- Eight tenant tables, each with the composite same-company FKs and in TENANT_TABLES.
- `jobs_company_id_id_uniq` is placed before the composite FKs that reference it.
- CHECK ranges, defaults and indexes match the brief.
- 0014: S/I/U to app_tenant, DELETE only on calendar_busy_blocks and calendar_event_links, ENABLE/FORCE RLS plus `tenant_isolation` with the exact predicate. app_system gets column SELECT (id, company_id, user_id, status, last_synced_at) on calendar_connections plus `app_system_all`.
- The company_settings/jobs column grants are asserted through `has_column_privilege` as the brief allows, because 0002 already grants table-wide.
- The 0014 snapshot differs from 0013 only in id/prevId and JSON key order.
- Lockfile adds only pdfkit, @types/pdfkit and their transitive packages.
- The barrels carry every C1 line: 12 repos, system/calendar-sync.ts, and the four shared files.
- No web or copy files are touched, so the copy, lint and `<button>` rules do not apply.
- CI ci-check run 38188918207 passed, including the database suites.

For the later wave-2 merges (T2, T3, T4 are not in this batch, but they depend on this one):
- Merge T1 first.
- c1-t2, c1-t3 and c1-t4 carry scratch commit ce04456. Its packages/shared slice matches T1's byte for byte, except that T1's shared/index.ts has an extra comment line (`// C1 skeleton (Task 1): ...`) above the four C1 export lines. Expect an add/add or content conflict there; resolve it by taking T1's index.ts exactly.
- availability.ts: keep T1's 12-line constants block, followed by T3's code below it. T3's file already begins with the same block, so the only real change is its additions from line 13 on.
- pipeline.ts, crm.ts, csv.ts: take the task branch's version.
- Drop or override T4's scratch commit c4c42d5 (BoardStage/WorkHours stubs) once T2 and T3 are in.

After merging, check that `npm run typecheck` (through ops/bin/slot) passes on c1-crm. The new @roofline/db exports (WeeklyHours, WeekdayKey, the table objects) do not clash with any F3 export names.
