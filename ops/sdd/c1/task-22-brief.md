### Task 22: Web: new customer, new job, add a home

**Base:** `c1-crm` after Task 18 is merged (T7's server geocoding for the real API; unit tests stub `fetch`). From T18: placeholders `features/create/{NewJob,NewCustomer,api}`, `copy/create.ts`. From `@roofline/shared`: `US_STATE_NAMES` (`address.ts`), `JOB_SOURCES` (seven values — the plan's "six" is wrong; show all seven as words), `JOB_STAGES`. Kit `Checkbox` comes from F3 T29. API (F1): `POST /api/customers`, `POST /api/properties`, `POST /api/jobs`, `GET /api/customers?q=&limit=8`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `NewCustomer.tsx`; Builder 2 `NewJob.tsx` (customer typeahead, home pick or new address); Builder 3 `AddHomeSheet.tsx`, `CustomerPicker.tsx`, `copy/create.ts`, `features/create/api.ts`, tests.

**Files:**
- Create: `apps/web/src/features/create/{AddHomeSheet,CustomerPicker,AddressFields}.tsx`
- Modify: `apps/web/src/features/create/{NewCustomer.tsx,NewJob.tsx,api.ts}`, `apps/web/src/copy/create.ts`
- Test: `apps/web/test/create.test.tsx`

**Interfaces:**
- **Hooks:** `useCreateCustomer()` (F1 `POST /api/customers`), `useCreateProperty()` (`POST /api/properties` without lat/lng → server geocodes), `useCreateJob()` (`POST /api/jobs`), `useCustomerSearch(q)` (`GET /api/customers?q=&limit=8`).
- **New customer** (`/customers/new`): first/last name (display name derived "First Last" unless edited), phone(s), email(s), optional first home (`AddressFields`: street, city, state `Select` of `US_STATE_NAMES`, ZIP), a `Checkbox` "They agreed to get texts about their jobs" (→ consent `express`, source `manual`). Save → creates the customer, then the home → navigate to `/customers/:id`. A home that wasn't found shows the toast `create.notOnMap` "Saved. We couldn't find that address on the map yet."
- **New job** (`/jobs/new`, optional `?customerId=`): step 1 `CustomerPicker` (typeahead; "New customer" inline: name + phone + email); step 2 pick one of the customer's homes or "New address" (`AddressFields`); step 3 stage (default Lead), source (default Manual; the seven F1 `JOB_SOURCES` as words), rep (rep: themselves, fixed), value. "Create job" → navigate to `/jobs/:id`. Click budget: from the map home ⌘K "New job" → form is 2 clicks (spec §13).
- **`AddHomeSheet({ customerId })`:** `AddressFields` + Save.

**Tests:**
- new customer posts customer then property, navigates; texting checkbox sends `express`; new job with an existing customer and home posts once and navigates; inline new customer path; a rep's rep field is fixed; field errors land under their fields.

**Carries and rulings:**
- `AddHomeSheet` is exported for T21; keep its props `{ customerId, onDone? }` stable.

**Verify notes:**
- web suite, lint, typecheck, build.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): create customers, jobs and homes from the screens`
