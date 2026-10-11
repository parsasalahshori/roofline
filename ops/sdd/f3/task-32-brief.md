### Task 32: Web: the Setup window and the progress ring

**Base:** `f3-setup` after Tasks 29 and 30 are merged (T4 is in; T15 and T16 for the real API, though the unit tests stub `fetch`). From T30: placeholders `features/setup/{SetupTab,SetupRing}.tsx` (`SetupTab` is the Settings `setup` tab; `SetupRing` is already rendered beside the avatar in `UserMenu`), empty `features/setup/api.ts`. From T29 (`@roofline/ui`): `ProgressRing`, `Banner`. From T4 (`@roofline/shared`): `SetupView`, `SetupItemView`, `SetupItemKey`, `SETUP_ITEM_KEYS`, `ComingWith`. API (T16): `GET /api/setup` → `SetupView`; `POST /api/setup/:key/skip|unskip` (owner) → `SetupView`. API (T15): `POST /api/company/locate` → `{ located: true }` (400 field `addressStreet`, 503), `PUT /api/company/service-area { radiusMiles }` (400 field `radiusMiles`, 409), `GET /api/company` gains `located: boolean`, `serviceAreaMiles: number | null`. From F2: `useCompany` (`features/settings/api.ts`), `useMe`, `keys`, `apiFetch`.

**Split:**
- Builder 1: `SetupTab.tsx` and `SetupRow.tsx`.
- Builder 2: `CompanyBasicsSheet.tsx` and `SetupRing.tsx`.
- Builder 3: `copy/setup.ts`, `features/setup/api.ts`, the `CompanyBody` type addition, and `apps/web/test/setup.test.tsx`.

**Files:**
- Create: `apps/web/src/features/setup/{SetupRow,CompanyBasicsSheet}.tsx` (+ CSS Modules as needed)
- Modify: `apps/web/src/features/setup/{SetupTab.tsx,SetupRing.tsx,api.ts}`, `apps/web/src/copy/setup.ts`, `apps/web/src/api/types.ts` (`CompanyBody` gains `located: boolean; serviceAreaMiles: number | null` — only this task in its group edits `types.ts`)
- Test: `apps/web/test/setup.test.tsx`
- Do not touch: `router.tsx`, `Settings.tsx`, `UserMenu.tsx`, `Shell.tsx` (T30's).

**Interfaces:**
- **Hooks (`features/setup/api.ts`):** `useSetup()` (query `['setup']`, `GET /api/setup`, `refetchOnWindowFocus: true`, `refetchInterval: 60_000`); `useSkip()` / `useUnskip()` (mutation taking `key`, POST, `setQueryData(['setup'], view)`); `useLocateCompany()` (POST locate, then invalidate `keys.company` and `['setup']`); `useServiceArea()` (PUT `{ radiusMiles }`, same invalidation). Add `setup: ['setup'] as const` to the hooks' own module (not `api/keys.ts`, to stay out of shared files) and export it.
- **`SetupTab`:** a list (`<ol aria-label={setup.listLabel}>`) of `SetupRow`s in API order; above it `setup.progress(done, total)` ("2 of 5 setup steps done"). Loading → `Skeleton`; error → the API message.
- **`SetupRow({ item, canAct })`:** title, description, the "Unlocks …" line when present, a status chip (`Pill` or text with `data-status`), one primary action, and for skippable rows a ghost "Skip for now" / "Undo skip".
  - **Chips:** `todo` "To do", `in_progress` "Started", `done` "Done", `skipped` "Skipped", `waiting` "Waiting on phone carriers (usually 10–15 days)", a rejected registration (`data.rejected === true`) "Needs a fix", and `comingWith` → "Coming with the Estimator" / "Coming with the calendar" / "Coming with Front Desk" / "Coming with Storm Scout" (no action button for those).
  - **Actions (owner only):** `company_basics` → "Check details" opens `CompanyBasicsSheet`; `import_customers` → "Import customers" → `/settings/setup/import`; `texting_registration` → "Start", or "Fix and resubmit" when rejected → `/settings/setup/texting` (none while `waiting` or `done`); `invite_team` → "Invite" → `/settings/team`; `payment_method` → "Add a card" → `/settings/billing`. Done rows show no primary action.
  - **Others** (`useMe().data.role !== 'owner'`): no buttons; one note above the list "Your owner finishes setup."
- **`CompanyBasicsSheet`** (a kit `Sheet`): "Place on map" (`useLocateCompany`, busy; a 400/503 shows the message) when `!company.located`; a `Select` of 10/20/40/60 miles (`setup.radius(n)` "20 miles") defaulting to `serviceAreaMiles ?? 40`, saving on change via `useServiceArea`; a ghost "Edit company details" → `/settings/company`.
- **`SetupRing`:** `useSetup()`; hidden (`null`) while loading, on error, or when `progress.done >= progress.total`; else a link (kit `Button variant="ghost" href="/settings/setup"`, `aria-label` = the label) wrapping `ProgressRing done total label={setup.ringLabel(done, total)}` ("2 of 5 setup steps done"), `size={24}`.
- **Copy (`copy/setup.ts`, vendor names allowed here; keep the F2 `later` key only if still used):** per key `{ title, description, unlocks? }`:
  - `companyBasics`: "Your company on the map" — "Your name, address and the area you work in."
  - `importCustomers`: "Bring in your customers" — "Upload a spreadsheet from your old system." — "Unlocks storm texts to your existing customers"
  - `textingRegistration`: "Register for texting" — "Phone carriers approve your business before you can text customers." — "Unlocks all texting"
  - `inviteTeam`: "Invite your team" — "Add your office staff and reps."
  - `paymentMethod`: "Add a card" — "Needed before anything that costs money, like texting. Card payments run through Stripe." — "Unlocks texting registration and exact roof reports"
  - `pricesAndTiers`: "Prices and Good/Better/Best" — "Your pricebook for estimates." — "Unlocks the Estimator"
  - `connectCalendar`: "Connect your calendar" — "Google or Outlook, so bookings land on your calendar." — "Unlocks Front Desk booking"
  - `phoneNumber`: "Your Roofline phone number" — "Forward your business line so every call is answered." — "Unlocks Front Desk"
  - `connectAds`: "Connect your ad accounts" — "Link Google Ads and share your Meta ad account." — "Unlocks storm ads"
  - Copy keys are camelCase; map API keys with a `Record<SetupItemKey, …>` built from `SETUP_ITEM_KEYS` (the snake_case values are banned *in copy text*, not as code keys — keep them out of strings).

**Tests (`setup.test.tsx`)** — stubbed `fetch` (`./helpers.tsx`), the app router at `/settings/setup`, `MapView` mocked:
- `it('lists nine steps with their chips')`: 9 rows; a `waiting` texting row reads exactly "Waiting on phone carriers (usually 10–15 days)".
- `it('later steps say what they come with')`: the four "Coming with …" lines.
- `it('the owner skips the import and the ring moves')`: ring label "1 of 5 setup steps done", click "Skip for now" (POST answers a view with done 2) → "2 of 5 setup steps done".
- `it('office sees no buttons')`: role office → no "Import customers"/"Skip for now"; the note shows.
- `it('a rejected registration offers Fix and resubmit')`: link to `/settings/setup/texting`.
- `it('the ring hides when setup is done')`: 5 of 5 → no ring.
- `it('the basics sheet places the company and sets the radius')`: "Place on map" POSTs locate; choosing 20 sends PUT body `{ radiusMiles: 20 }`.

**Verify notes:**
- Web only: `npx vitest run --project @roofline/web setup && npm run lint && npm run lint:css && npm run typecheck && npm run build:web` (copy-rules included).
- Commit: `feat(web): Setup window with live statuses and a progress ring`.
