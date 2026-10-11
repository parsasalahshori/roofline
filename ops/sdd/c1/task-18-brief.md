### Task 18: Web skeleton for the C1 screens

**Base:** `c1-crm` after Task 4 is merged; F3 **Task 30** (web skeleton: `Settings.tsx` with an optional `subpage`, `tabs.ts` with `LaterTabKey = 'connections'`, `features/setup/*` placeholders) and F3 **Task 29** (kit `Checkbox`, `Banner`) must be in `f3-setup`. Current shapes (`origin/f3-setup`): `apps/web/src/shell/apps.ts` (`AppKey`, `WindowKey` incl. `'customers'`, `ComingSoonKey`, `DockApp` with **`shipped: false` as a literal type**, `DOCK_APPS`), `copy/dock.ts` (`WINDOW_COPY: Record<WindowKey, …>`), `copy/comingSoon.ts`, `shell/AppWindow.tsx`, `app/router.tsx`, `features/settings/{Settings.tsx,tabs.ts,LaterTab.tsx}`, `api/hooks.ts` (`useMe` → `{ user, company }`), `@roofline/ui` `EmptyState`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:**
- Builder 1: `router.tsx` routes, `shell/apps.ts` (Jobs and Calendar shipped), `copy/dock.ts`/`WINDOW_COPY` additions, `shell/apps.ts` `WindowKey` additions.
- Builder 2: `features/settings/{Settings.tsx,tabs.ts}` (Prices, Schedule tabs), the placeholder components and empty `api.ts` modules.
- Builder 3: the copy files (each with a `comingSoon` line used by its placeholder), `apps/web/test/c1-routes.test.tsx`, and the F2/F3 tests that asserted "coming soon" for Jobs/Calendar.

**Files:**
- Create (placeholders render `EmptyState` with their copy's `comingSoon`):
  - `apps/web/src/features/jobs/{JobsWindow,api}.tsx|ts`, `features/job/{JobWindow,api}.tsx|ts`, `features/customers/{CustomersWindow,CustomerWindow,api}.tsx|ts`, `features/create/{NewJob,NewCustomer,api}.tsx|ts`, `features/calendar/{CalendarWindow,api}.tsx|ts`, `features/appointments/{AppointmentWindow,api}.tsx|ts`, `features/quotes/{QuoteWindow,api}.tsx|ts`, `features/settings/{PricesTab,ScheduleTab}.tsx`
  - copy: `apps/web/src/copy/{jobs,job,customers,create,calendar,appointments,prices,schedule,quotes}.ts`
  - `apps/web/test/c1-routes.test.tsx`
- Modify: `apps/web/src/app/router.tsx`, `apps/web/src/shell/apps.ts`, `apps/web/src/copy/dock.ts`, `apps/web/src/copy/comingSoon.ts` (drop jobs/calendar/customers lines if unused), `apps/web/src/features/settings/{Settings.tsx,tabs.ts}`, `apps/web/src/copy/settings.ts` (tab labels "Prices", "Schedule"), tests that expected the old placeholders.
- Also create: `apps/web/src/features/settings/ConnectionsTab.tsx` (Ruling CA) and `apps/web/src/shell/recents.ts` — `type Recent = { kind: 'job' | 'customer'; id: string; label: string }`, `readRecents(companyId): Recent[]`, `recordRecent(companyId, r)` (localStorage key `roofline.recents.<companyId>`, newest first, at most 8, every access in try/catch), `useRecordRecent(r)` (records once per mount using `useMe().data.company.id`). Tasks 20 and 21 call it; Task 27 reads it.
- Do not touch: `Shell.tsx`, `UserMenu.tsx` (no C1 slot needed), `api/types.ts`, `api/hooks.ts`.

**Interfaces:**
- **Routes** (under the session shell; all through `AppWindow`), replacing the `jobs/*`, `calendar/*`, `customers/*` "coming soon" routes:
  - `jobs` → `<AppWindow app="jobs"><JobsWindow /></AppWindow>` (board/list by `?view=`), `jobs/new` → `NewJob`, `jobs/:jobId` → `JobWindow`, `jobs/:jobId/quotes/:quoteId` → `QuoteWindow` (inside the job window's `AppWindow app="jobs"`).
  - `customers` → `CustomersWindow` (window key `customers`, title "Customers"), `customers/new` → `NewCustomer`, `customers/:customerId` → `CustomerWindow`.
  - `calendar` → `CalendarWindow` (`?view=&date=&people=`), `calendar/new` → `AppointmentWindow` (new; `?jobId=&customerId=&kind=&start=`), `calendar/appointments/:appointmentId` → `AppointmentWindow`.
  - `settings/:tab` accepts `prices` and `schedule` (owner/office see Prices; everyone sees Schedule).
- **Dock:** `DockApp.shipped` becomes `boolean`; `jobs` and `calendar` are `true` (no "Coming soon" note); phone tabs unchanged (they already link `/jobs`, `/calendar`).
- **`WINDOW_COPY`:** `customers: { title: 'Customers', description: 'Everyone you work with' }`; jobs/calendar descriptions unchanged.
- **Jobs window tabs:** `JobsWindow` renders a tab row "Pipeline" (`/jobs`) · "Customers" (`/customers`) — the `CustomersWindow` renders the same tab row (Decision 8); the shared tab row lives in `features/jobs/JobsTabs.tsx` (created here).

**Tests:**
- (`c1-routes.test.tsx`): each new URL renders its placeholder inside the right dialog; `/settings/prices` for owner, and office; `/settings/schedule` for a rep; the dock's Jobs and Calendar have no "Coming soon"; unknown `/jobs/x/y/z` still shows Not found where appropriate.

**Carries and rulings:**
- **Ruling CA:** create `features/settings/ConnectionsTab.tsx` (renders today's `connections.later` line exactly as `LaterTab` does) and map the `connections` tab to it; drop `'connections'` from `LaterTabKey` (keep `LaterTab` if any tab still uses it, else delete it with its test lines). T25 adds `CalendarConnection` inside `ConnectionsTab` instead of editing `LaterTab`.
- **Ruling CB:** `DockApp.shipped` becomes `boolean` (it is the literal `false` today); update the F2/F3 tests that assert every app is "Coming soon".
- Create `shell/recents.ts` and `features/jobs/JobsTabs.tsx` here (plan).
- This task owns `router.tsx`, `shell/apps.ts`, `copy/dock.ts`, `copy/comingSoon.ts`, `Settings.tsx`, `tabs.ts` for C1.

**Verify notes:**
- `npx vitest run --project @roofline/web && npm run lint && npm run lint:css && npm run typecheck && npm run build:web`.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): routes, dock and settings tabs for the C1 screens`
