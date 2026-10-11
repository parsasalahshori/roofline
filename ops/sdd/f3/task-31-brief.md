### Task 31: Web: sign-up wizard and the Google button

**Base:** `f3-setup` after Tasks **15**, 29 and 30 are merged. From T15 (API): `GET /api/auth/config` → `{ googleClientId: string | null }` (public), and the sign-up/Google bodies `companyName`, `companyPhone`, `companyAddress` with field errors on those names (a new Google user with no company details gets 400 field `companyName`). From T30: the placeholder `features/signup/SignUp.tsx` (routed at public `/sign-up`), empty `features/signup/api.ts`, `auth.comingSoon`. From F2: `apiFetch`/`ApiError` (`api/client.ts`), `keys.me`, `Field`, `Button` from `@roofline/ui`, `features/auth/{SignIn,AuthLayout,formErrors}.tsx|ts`.
**Plan conflict (proposed Ruling AI):** the plan says the CSP lives in `apps/api/src/web.ts`; on `f3-setup` it is `contentSecurityPolicy()` in `apps/api/src/app.ts` (`helmet({ contentSecurityPolicy })`). Edit it there; no other task in this group touches `app.ts`.

**Split:**
- Builder 1: `SignUp.tsx`, `AccountStep.tsx`, `CompanyStep.tsx` and `features/signup/api.ts`.
- Builder 2: `GoogleButton.tsx` and the CSP in `apps/api/src/app.ts` (+ the `web.test.ts` assertion).
- Builder 3: `copy/auth.ts`, the `SignIn.tsx` link and Google button, and `apps/web/test/signup.test.tsx`.

**Files:**
- Create: `apps/web/src/features/signup/{AccountStep,CompanyStep,GoogleButton}.tsx`
- Modify: `apps/web/src/features/signup/{SignUp.tsx,api.ts}`, `apps/web/src/copy/auth.ts`, `apps/web/src/features/auth/SignIn.tsx`, `apps/api/src/app.ts` (`contentSecurityPolicy` only)
- Test: `apps/web/test/signup.test.tsx`, `apps/api/test/web.test.ts` (extend)
- Do not touch: `router.tsx` (T30 already routes `/sign-up`).

**Interfaces:**
- **CSP additions** (in `contentSecurityPolicy`): `scriptSrc` + `https://accounts.google.com/gsi/client`; `frameSrc` (new) `https://accounts.google.com/gsi/`; `connectSrc` + `https://accounts.google.com/gsi/`; `styleSrc` + `https://accounts.google.com/gsi/style`. Append each Google source **after** the existing entries: `web.test.ts`'s current test checks substrings such as `"connect-src 'self' https://api.maptiler.com https://tile.openstreetmap.org"` and `"style-src 'self' 'unsafe-inline'"`, which must stay contiguous; rename that test to `lets the map and Google sign-in in and nothing else`.
- **Hooks (`features/signup/api.ts`):** `useAuthConfig()` (query `['auth-config']`, `GET /api/auth/config`, `staleTime: Infinity`, `redirectOn401: false`); `useSignUp()` (POST `/api/auth/signup`, `redirectOn401: false`); `useGoogleSignIn()` (POST `/api/auth/google`, `redirectOn401: false`). On success both mutations `queryClient.clear()` then set nothing (the page navigates).
- **`SignUp`:** in `AuthLayout`, title `auth.signUpTitle`, note `auth.trialNote`.
  - **Step 1 (`AccountStep`):** three `Field`s — `auth.yourName`, `auth.email`, `auth.password` (help `auth.passwordHelp`, at least 10 characters checked client-side with the server's message) — and a primary `auth.continue`; below, the `GoogleButton` when a client id exists.
  - **Step 2 (`CompanyStep`):** exactly three `Field`s — `auth.companyName`, `auth.businessPhone` (`type="tel"`), `auth.businessAddress` (help `auth.addressHelp`) — and a primary `auth.startTrial` (busy while pending); a ghost "back" is not needed.
  - **Submit:** POST `{ name, email, password, companyName, companyPhone, companyAddress }` (exactly these keys). Success → `invalidateQueries({ queryKey: keys.me })`, `navigate('/settings/setup', { replace: true })`.
  - **Field errors:** an `ApiError` with `field` `email`/`password`/`name` → back to step 1 with the error under that field; `companyName`/`companyPhone`/`companyAddress` → stay on step 2 under that field; no field → toast the message.
  - **Google:** `onCredential(credential)` → POST `{ credential }`. 200 → `navigate('/')`. 400 with field `companyName` → hold the credential in a ref, go to step 2; step 2's submit then POSTs `/api/auth/google` with `{ credential, companyName, companyPhone, companyAddress }`.
- **`GoogleButton({ clientId, onCredential })`:** renders `null` when `clientId` is null. Otherwise a container `div`; loads `https://accounts.google.com/gsi/client` once per page (a module-level promise; `<script async>` appended to `document.head`), then `window.google.accounts.id.initialize({ client_id: clientId, callback: ({ credential }) => onCredential(credential) })` and `renderButton(container, { type: 'standard', text: 'continue_with', width: 280 })`. If the script fails, render a disabled kit `Button` with `auth.googleFallback`. Type `window.google` in a local `declare global` block.
- **Copy (`auth.ts`, append; reuse the existing `continue` "Continue" and `email`/`password`):** `signUpTitle` "Start your free trial", `trialNote` "14 days free. No card needed.", `yourName` "Your name", `companyName` "Company name", `businessPhone` "Business phone", `businessAddress` "Business address", `addressHelp` "Street, city, state and ZIP", `startTrial` "Start my free trial", `haveAccount` "Already have an account? Sign in", `createAccount` "Create an account", `googleFallback` "Sign in with Google". Remove T30's `comingSoon` key if nothing uses it any more. "Google" is allowed in `copy/auth.ts`.
- **`SignIn.tsx`:** a ghost `Button href="/sign-up"` with `auth.createAccount`, and the `GoogleButton` (Google sign-in of an existing account → `navigate(next ?? '/')`; a 400 field `companyName` → `navigate('/sign-up')`, since the account is new). `SignUp` shows a ghost link `auth.haveAccount` → `/sign-in`.

**Tests:**
- `signup.test.tsx` (stubbed `fetch` via `./helpers.tsx`; `GET /api/auth/me` → 401; `GET /api/auth/config` → `{ googleClientId: null }` unless stated):
  - `it('signs up in two steps and opens Setup')`: the POST body has exactly `name, email, password, companyName, companyPhone, companyAddress`; then `where(router) === '/settings/setup'`.
  - `it('shows a taken email back on step 1')`: 409 `{ error, field: 'email' }` → step 1 with the error under Email.
  - `it('shows an address problem on step 2')`: 400 field `companyAddress` → the message under Business address, still on step 2.
  - `it('Google: an existing account goes to the map, a new one asks for the company')`: a fake `window.google.accounts.id` whose `initialize` captures the callback and a pre-resolved script loader (mark the script loaded by setting `window.google` before render); 200 → `/`; 400 field `companyName` → step 2, then the second POST body has `credential` and the three company fields.
  - `it('step 2 has three inputs')`: `within(form).getAllByRole('textbox')` length 3.
- `web.test.ts` (extend): the `Content-Security-Policy` header contains `https://accounts.google.com/gsi/client` and `frame-src https://accounts.google.com/gsi/`.

**Verify notes:**
- `npx vitest run --project @roofline/web signup auth` and `npm run lint && npm run lint:css && npm run typecheck && npm run build:web` locally. `web.test.ts` is in the api project (needs Docker for its globalSetup): prove it with `ops/bin/ci-check`.
- Commit: `feat(web): self-serve sign-up in two short steps, with Sign in with Google`.
