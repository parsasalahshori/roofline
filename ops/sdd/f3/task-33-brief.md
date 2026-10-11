### Task 33: Web: the Billing tab and the banners

**Base:** `f3-setup` after Tasks 29 and 30 are merged (T3 is in; T19 and T21 give the real API, though the unit tests stub `fetch`). From T30: placeholders `features/billing/{BillingTab,ShellBanners}.tsx` (`BillingTab` is the Settings `billing` tab; `ShellBanners` is already rendered in the Shell's banner slot under the top bar, whose height pushes the windows down — Ruling AH), empty `features/billing/api.ts`. From T29: `Banner`, `ProgressBar`. From T3 (`@roofline/shared`): `BillingView`, `PlanSummary`, `Meter`. API (T19): `GET /api/billing` (owner), `POST /api/billing/checkout { planKey }` → `{ url }`, `POST /api/billing/portal` → `{ url }`, `POST /api/billing/plan { planKey }` → `{ ok }`. `useMe().data.company.status` is the `CompanyStatus` (F2 `Account`).
**Carry (T3's scan):** no `19900`/`39900` in any `src` file; format prices from cents. Tests may contain them.

**Split:**
- Builder 1: `BillingTab.tsx`, `PlanPicker.tsx`, `UsageMeters.tsx`.
- Builder 2: `ShellBanners.tsx`.
- Builder 3: `copy/billing.ts`, `features/billing/api.ts`, `apps/web/test/billing.test.tsx`.

**Files:**
- Create: `apps/web/src/features/billing/{PlanPicker,UsageMeters}.tsx` (+ CSS Modules)
- Modify: `apps/web/src/features/billing/{BillingTab.tsx,ShellBanners.tsx,api.ts}`, `apps/web/src/copy/billing.ts`
- Test: `apps/web/test/billing.test.tsx`
- Do not touch: `Shell.tsx`, `Settings.tsx`, `router.tsx`.

**Interfaces:**
- **Hooks (`features/billing/api.ts`):** `useBilling()` (query `['billing']`, `enabled` only for the owner), `useCheckout()`, `usePortal()`, `useChangePlan()`. Checkout and portal follow the returned URL with `window.location.assign(url)` in `onSuccess`; change plan toasts `billing.planChangeRequested` "Your plan change is on its way." and invalidates `['billing']`.
- **`BillingTab`:**
  - **Owner:** plan name (or `billing.noPlan` "No plan yet") and status — `trial` → `billing.trialUntil(date)` "Free trial until Oct 25" (`Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })`), `active` "Active", `past_due` "Payment didn't go through", `trial_ended` "Trial ended", `canceled` "Canceled".
  - **`UsageMeters`:** per usage entry a line and a `ProgressBar` when `included` is set: `${used} of ${included} text segments` / `${used} of ${included} AI call minutes`; with `included: null`, `${used} so far` (no bar). Labels "Text segments" / "AI call minutes".
  - **`PlanPicker`:** a `Card` per plan: name, `billing.perMonth(cents)` "$199/month" (whole-dollar `Intl.NumberFormat` USD, `maximumFractionDigits: 0`), `billing.includes(aiMinutes, smsSegments)` "Includes 300 AI call minutes and 1,000 text segments"; button "Pick this plan" → checkout when `!hasPaymentMethod`, "Switch to this plan" → change plan when subscribed; the current plan shows "Your plan" instead of a button.
  - "Invoices and card" (ghost) → portal, shown when `canOpenPortal`.
  - `billing.cardNote` "Card payments run through Stripe." under the plans.
  - **`?checkout=done`** (read with `useSearchParams`) → toast `billing.thanks` "Thanks! Your plan is set up.", invalidate `keys.me` and `['billing']`, then remove the param (`setSearchParams({}, { replace: true })`) so a reload does not toast again.
  - **Others:** `EmptyState` `billing.ownerOnly` "Only the owner can see billing."
- **`ShellBanners`** (from `useMe().data?.company.status` and `role`):
  - `trial_ended`: `Banner tone="warning"` "Your free trial has ended. Your data is safe and you can still look around." + `Button href="/settings/billing"` "Pick a plan to keep going".
  - `canceled`: "Your plan was canceled. Your data is safe and you can still look around." + the same button.
  - `past_due`: `Banner tone="danger"` "Your payment didn't go through. Texts and calls are paused until it's fixed." + for the owner `Button` "Fix payment" (→ `usePortal`), for others the text "Ask your owner to update the card."
  - Nothing (`null`) for `trial`, `active` or while loading.
- **Copy:** all strings above in `copy/billing.ts` (Stripe allowed there); keep F2's `later` key only if still used.

**Tests (`billing.test.tsx`)** — stubbed `fetch`, app router, `MapView` mocked; `vi.spyOn(window.location, 'assign')` won't work in jsdom — stub `window.location` with `vi.stubGlobal('location', { ...window.location, assign: vi.fn() })` or inject an `assign` helper exported from `api.ts` (`export const go = { assign: (u: string) => window.location.assign(u) }`) and spy on it:
- `it('owner sees the plan, usage and plans')`: usage `{ meter: 'sms_segment', used: 6, included: null }` → "6 so far"; a plan with `monthlyPriceCents: 19900` → "$199/month".
- `it('Pick this plan goes to checkout')`: POST `{ planKey: 'starter' }` → `assign` called with `https://checkout.stripe.test/c/cs_fake_1`.
- `it('subscribed owners switch plans in place')`: `hasPaymentMethod: true` → "Switch to this plan" → POST `/api/billing/plan`, toast shown.
- `it('office sees the owner-only note')` and no `GET /api/billing` call.
- `it('trial ended shows the pick-a-plan banner')`: `ACCOUNT.company.status = 'trial_ended'` → button "Pick a plan to keep going" (exact).
- `it('past due shows the payment banner')`: exact text; the owner gets "Fix payment"; an office user gets "Ask your owner to update the card."
- `it('no banner while in trial or active')`.
- `it('thanks after checkout, once')`: `/settings/billing?checkout=done` → the toast, then the URL is `/settings/billing`.

**Verify notes:**
- Web only: `npx vitest run --project @roofline/web billing && npm run lint && npm run lint:css && npm run typecheck && npm run build:web`, plus `npx vitest run --project @roofline/shared billing` (prices scan).
- Commit: `feat(web): billing page, plan picker and the trial and payment banners`.
