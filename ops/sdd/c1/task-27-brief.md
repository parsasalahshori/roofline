### Task 27: Web: Today, ⌘K actions and recents, map focus, export buttons

**Base:** `c1-crm` after Task 18 is merged (T8 for `GET /api/today`). Current shapes: `features/today/{Today.tsx,api.ts}` (F2: `useTodayShown` only; "No appointments yet" line), `shell/topbar/{SearchDialog.tsx,searchOptions.ts}` (F2 search over `GET /api/search`), `shell/map/{MapView.tsx,interactions.ts,pins.ts}` (no focus param yet). From T18: `readRecents` (`shell/recents.ts`). From T4: `TodayView`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 Today (`features/today/Today.tsx` sections "Today's appointments" and "Follow up today", `features/today/api.ts` `useToday`); Builder 2 ⌘K (`shell/topbar/SearchDialog.tsx`, `searchOptions.ts`: actions group and recents, `shell/recents.ts`); Builder 3 map focus (`shell/map/MapView.tsx`: `?focus=<propertyId>`), `copy/{today,search}.ts`, tests.

**Files:**
- Modify: `apps/web/src/features/today/{Today.tsx,api.ts}`, `apps/web/src/shell/topbar/{SearchDialog.tsx,searchOptions.ts}`, `apps/web/src/shell/map/MapView.tsx`, `apps/web/src/copy/{today,search}.ts`
- Test: `apps/web/test/{today-crm,search-actions,map-focus}.test.tsx`

**Interfaces:**
- **Today:** replaces F2's "No appointments yet" with `useToday()` (`GET /api/today`): appointment rows (time, kind, customer, address; link to the appointment), owner/office link `today.seeEveryone` → `/calendar?view=day&date=<today>`; "Follow up today" rows (`JobCard` name + next step, link to the job). Empty states `today.noAppointments` "Nothing on your calendar today." and none for follow-ups (section hidden).
- **⌘K:** an **Actions** group matched by words in the query (`search.actions`: "New job" → `/jobs/new`, "New customer" → `/customers/new`, "Book an inspection" → `/calendar/new?kind=inspection`, "Open calendar" → `/calendar`, "Download customers" (owner/office) → the CSV), shown above results; with an empty query, **Recent** = `readRecents(companyId)` from Task 18's `shell/recents.ts`; keyboard navigation unchanged.
- **Map focus:** `/?focus=<propertyId>` → after pins load, fly to the pin (`easeTo`, zoom 16) and open its card; unknown id → nothing.

**Tests:**
- Today lists appointments and follow-ups from a stubbed `/api/today`; the "see everyone" link for owner only; ⌘K "new" shows New job/New customer; Enter on an action navigates; recents show on empty query (seeded storage) and survive a storage error; map focus calls `easeTo` with the pin's coordinates (map mocked as in F2's map tests).

**Carries and rulings:**
- Recents survive a throwing `localStorage` (Ruling 10).

**Verify notes:**
- web suite, lint, typecheck, build.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): today's appointments and follow-ups, search actions and recents, map focus`
