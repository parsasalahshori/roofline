### Task 25: Web: Settings Prices, Schedule and Your calendar; the setup row

**Base:** `c1-crm` after Task 18 is merged; F3 **Task 32** (`features/setup/SetupRow.tsx`, `SetupTab`) must be in `f3-setup`. From T18: `PricesTab`, `ScheduleTab` placeholders and **`ConnectionsTab.tsx`** (Ruling CA). From F3 T32: `SetupRow({ item, canAct })`. From T4: `PricebookView`, `ScheduleSettings`, `CalendarConnectionView`. From T3: `WorkHoursSchema`, `WEEKDAYS`. Kit `Banner` (F3 T29).

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `PricesTab.tsx`; Builder 2 `ScheduleTab.tsx` (company hours and settings for the owner; my hours for everyone; `WorkHoursEditor.tsx`); Builder 3 `CalendarConnection.tsx` in the Connections tab, the `SetupRow` change, `copy/{prices,schedule}.ts`, `copy/connections.ts` and `copy/setup.ts` additions, tests.

**Files:**
- Create: `apps/web/src/features/settings/{WorkHoursEditor,CalendarConnection}.tsx`, `apps/web/src/features/settings/crm-api.ts`
- Modify: `apps/web/src/features/settings/{PricesTab,ScheduleTab,ConnectionsTab}.tsx` (`ConnectionsTab` renders `CalendarConnection` above the ad-accounts line — Ruling CA; `LaterTab.tsx` is not touched), `apps/web/src/features/setup/SetupRow.tsx` (the `connect_calendar` action), `apps/web/src/copy/{prices,schedule,connections,setup}.ts`
- Test: `apps/web/test/{settings-prices,settings-schedule,calendar-connection}.test.tsx`

**Interfaces:**
- **Hooks (`crm-api.ts`):** `usePricebook()`, `useSavePricebook()`, `useScheduleSettings()`, `useSaveScheduleSettings()`, `useMyHours()`, `useSaveMyHours()`, `useCalendarConnection()`, `useCalendars()`, `useChooseCalendar()`, `useDisconnectCalendar()`.
- **Prices:** groups Materials (architectural bundle, designer bundle, metal per square), Labor (per square, metal per square, tear-off, steep, extra story), Per-foot (ridge, drip edge, valley), Other (underlayment per square, decking per sheet, disposal, permit), and defaults (waste %, markup %, tax %, material). Dollar `Field`s; owner saves, office read-only with `prices.ownerOnly`; `isExample` → `Banner tone="info"` "Example prices — set your own."
- **Schedule:** owner: company work hours (`WorkHoursEditor`: per weekday on/off and up to 3 time ranges), travel buffer, minimum notice, stuck days; everyone: "Your hours" (`Toggle` "Use the company hours" or own editor). Validation errors from the API by field.
- **Your calendar** (`CalendarConnection`): not connected → two buttons "Connect Google Calendar" and "Connect Outlook" (plain anchors to `/api/calendar/connect/google|microsoft`, disabled with "Calendar connections aren't set up yet." when `configured` is false); connected → account email, calendar `Select` (from `useCalendars`), last synced time, "Disconnect" (confirm: "Your appointments stay in Roofline and on your calendar."); `error` → `Banner tone="danger"` "Reconnect your calendar" + the connect button. Reads `?calendar=connected|failed|canceled|not-set-up` once and toasts. Vendor words come from `copy/connections.ts`.
- **Setup row:** `connect_calendar` now has the action "Connect your calendar" → `/settings/connections` (owner and everyone else may act on their own connection; the row's owner-only rule does not apply to this action); its copy in `copy/setup.ts` drops "Coming with the calendar".

**Tests:**
- prices save body equals `pricebookSchema` shape in dollars; office read-only; schedule editor rejects overlapping ranges with the API's message; my hours toggle; connection states (not configured, connect hrefs, connected with a calendar change, error banner, `?calendar=connected` toast once); setup row action link.

**Carries and rulings:**
- **Ruling CA** (see T18): `CalendarConnection` goes inside `ConnectionsTab.tsx`; do not edit `LaterTab.tsx`. This task is the only C1 editor of `features/setup/SetupRow.tsx` and `copy/setup.ts`.

**Verify notes:**
- web suite, lint, typecheck, build (copy-rules: vendor names only in `connections.ts`/`setup.ts`).
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): prices, schedule and your calendar in Settings`
