### Task 35: Web: the texting registration form and status

**Base:** `f3-setup` after Tasks 29 and 30 are merged (T5 is in; T27/T28 give the real API, though the unit tests stub `fetch`). From T30: placeholder `features/texting/TextingSetup.tsx` (routed at `/settings/setup/texting`, inside the Settings window with the Setup tab current), empty `features/texting/api.ts`, `copy/texting.ts` (`texting`). From T29: `Checkbox`, `Banner`. From T5 (`@roofline/shared`): `TextingView`, `TextingState`, `BrandInfo`, `BrandField`, `BRAND_FIELDS`, `BUSINESS_TYPES`, `USE_CASE_LABEL`, `displayUsPhone`. API (T27): `GET /api/texting` → `TextingView`; `POST /api/texting/registration { brand, useHostedPolicyPages }` → 202 `TextingView`; 403 messages; 409 "Your registration is already with the phone carriers."; field errors `brand.<field>`.

**Split:**
- Builder 1: `TextingForm.tsx`.
- Builder 2: `TextingStatus.tsx` and `TextingSetup.tsx`.
- Builder 3: `copy/texting.ts`, `features/texting/api.ts`, `apps/web/test/texting.test.tsx`.

**Files:**
- Create: `apps/web/src/features/texting/{TextingForm,TextingStatus}.tsx` (+ CSS Module)
- Modify: `apps/web/src/features/texting/{TextingSetup.tsx,api.ts}`, `apps/web/src/copy/texting.ts`
- Test: `apps/web/test/texting.test.tsx`

**Interfaces:**
- **Hooks:** `useTexting()` (query `['texting']`), `useSubmitRegistration()` (POST; `onSuccess` sets `['texting']` to the answer).
- **`TextingSetup`:** `not_started`, `needs_fix` → `TextingForm`; `waiting`, `approved` → `TextingStatus`; loading → `Skeleton`.
- **`TextingForm`:**
  - One `Field` per `BRAND_FIELDS` entry except `businessType`, which is a `Select` with LLC / Corporation / Partnership / Non-profit (values `llc`, `corporation`, `partnership`, `non_profit` — values are code, labels from copy). Labels: Legal business name, EIN, Business type, Street, City, State, ZIP, Website, Contact first name, Contact last name, Contact email, Contact phone, Contact job title. Prefilled from `view.brand ?? view.defaults` (missing → '').
  - `Checkbox` "Use the Roofline page for your privacy policy and terms", on by default when the prefilled website is empty; when on, it shows the two hosted URLs (`view.hostedPolicyUrls.privacy`/`.terms`) as links.
  - The line `texting.whatYouText(USE_CASE_LABEL)` → "What you'll text: Customer care + marketing (mixed)".
  - `needsPaymentMethod` → `Banner tone="warning"` "Add a card first. Texting registration has a carrier fee." with a link "Add a card" → `/settings/billing`; the submit button is `disabled`.
  - `needsVerifiedEmail` → `Banner tone="warning"` "Please confirm your email first. We sent you a link." (submit disabled too).
  - **`needs_fix`:** `view.reason` at the top (`Banner tone="danger"`); every field in `view.rejectedFields` gets `error={texting.checkThis}` "Please check this." until edited; the button reads "Fix and resubmit" (else "Send to the phone carriers").
  - Submit → `{ brand: { …all 13 fields… }, useHostedPolicyPages }`; a 400 with field `brand.<f>` shows under that field; other errors → toast.
- **`TextingStatus`:** `waiting` → "Waiting on phone carriers (usually 10–15 days)" and `texting.submittedOn(date)` "Sent on Oct 11"; `approved` → `texting.on(displayUsPhone(number))` "Texting is on. Your number is (402) 555-0100."
- **Copy:** all strings in `copy/texting.ts`; camelCase keys; **no vendor names** in this file (allowed only in `connections/setup/auth/billing/legal`); `non_profit` etc. are banned in copy text, so labels are plain words. Drop T30's `comingSoon` if unused.

**Tests (`texting.test.tsx`)** — stubbed `fetch`, app router at `/settings/setup/texting`, `MapView` mocked:
- `it('prefills from the company and submits')`: `defaults` with a legal name and an empty website → the POST body is `{ brand: { …13 fields… }, useHostedPolicyPages: true }` with the typed values.
- `it('needs a card first')`: `needsPaymentMethod: true` → the banner text and the submit button `toBeDisabled()`.
- `it('shows the reason and highlights fields on a rejection')`: `state 'needs_fix'`, `rejectedFields ['legalName','ein']` → both fields show "Please check this."; button "Fix and resubmit".
- `it('shows waiting after submit')`: the 202 answer `state 'waiting'` → the waiting line.
- `it('shows the number once approved')`: "Texting is on. Your number is (402) 555-0100."
- `it('a server field error lands under its field')`: 400 field `brand.ein` → the message under EIN.

**Verify notes:**
- Web only: `npx vitest run --project @roofline/web texting && npm run lint && npm run lint:css && npm run typecheck && npm run build:web`.
- Commit: `feat(web): texting registration form, carrier status, Fix and resubmit`.
