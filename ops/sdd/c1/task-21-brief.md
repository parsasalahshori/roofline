### Task 21: Web: customers list and customer window

**Base:** `c1-crm` after Tasks 19 and 22 are merged. From T19: `<Timeline customerId />`. From T22: `AddHomeSheet` (`features/create/AddHomeSheet.tsx`). From T18: `JobsTabs`, `useRecordRecent`, placeholders `features/customers/*`, `copy/customers.ts`. From T4: `CustomerView`, `JobCard`. API: F1 `GET /api/customers?q=&limit=&offset=&archived=`, `PATCH /api/customers/:id` (duplicate phone → 400 naming the other customer), `POST /api/customers/:id/archive|restore`; T7 `GET /api/customers/:id/view`, `POST /api/properties/:id/locate`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `CustomersWindow.tsx` (list, filters, export); Builder 2 `CustomerWindow.tsx` (header, homes, jobs, upcoming, timeline import); Builder 3 `EditCustomerSheet.tsx` (names, phones, emails, tags, consent, do-not-contact), `copy/customers.ts`, `features/customers/api.ts`, tests.

**Files:**
- Create: `apps/web/src/features/customers/{CustomerHeader,CustomerHomes,EditCustomerSheet,ConsentChip}.tsx`
- Modify: `apps/web/src/features/customers/{CustomersWindow.tsx,CustomerWindow.tsx,api.ts}`, `apps/web/src/copy/customers.ts`
- Test: `apps/web/test/{customers-list,customer-window}.test.tsx`

**Interfaces:**
- **Hooks:** `useCustomers({ q, archived, offset })` (`GET /api/customers` — the F1 list, already sorted by name; tag and texting filters apply client-side to the loaded page, noted as a follow-up for a server filter), `useCustomerView(id)`, `useUpdateCustomer(id)` (F1 PATCH), `useArchiveCustomer(id)`.
- **List:** `JobsTabs` (Task 18) on top; search `Field`; filters; rows (name, primary phone, city, texting chip, jobs count); "New customer" → `/customers/new`; "Download customers" (owner/office → `/api/export/customers.csv`).
- **Customer window:** `AppWindow app="customers"`; header with the texting `ConsentChip` (`customers.consent.none` "No texting consent", `express` "Texts about their own jobs only", `attested`/`written` "OK to text", `revoked` "Asked not to be texted") and "Do not contact"; phones as `tel:` links on phone; homes (address, "Not on the map yet" + "Place on map" → `POST /api/properties/:id/locate`), jobs (`JobCard` rows with stage chips), upcoming appointments, timeline (`<Timeline customerId=… />` from Task 19). Calls `useRecordRecent({ kind: 'customer', id, label })`.
- **Edit sheet:** names; phones (add/remove, label, primary); emails; tags (comma input); consent `Select` (only when `can.changeConsent`; raising to `attested`/`written` shows a confirm line "Only do this if they agreed in writing or in your records"); do-not-contact `Toggle`; a duplicate-phone 400 shows under the phone with "Open that customer" link (the API message names them).
- **Actions:** New job (`/jobs/new?customerId=`), Add a home (`/customers/:id?addHome=1` opens Task 22's `AddHomeSheet` — imported from `features/create`), Book an appointment (`/calendar/new?customerId=`), Archive/Restore.

**Tests:**
- list search sends `q`; consent chip words; office changes consent with the confirm; a rep sees no consent select; duplicate phone error shows the link; Place on map posts locate; archive confirm.

**Carries and rulings:**
- Tag and texting filters apply client-side to the loaded page (plan); note it in the report as a follow-up.

**Verify notes:**
- web suite, lint, typecheck, build.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): customers list and customer window with editing and the timeline`
