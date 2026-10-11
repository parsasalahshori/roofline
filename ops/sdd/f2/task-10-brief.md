### Task 10: Web: API client, auth pages, router skeleton

**Files:**
- Create: `apps/web/src/api/{client,types,keys,hooks}.ts`, `apps/web/src/app/{router,providers,RequireSession}.tsx`, `apps/web/src/features/auth/{SignIn,ResetPassword,VerifyEmail,AcceptInvite}.tsx`, `apps/web/src/features/auth/safeNext.ts`, `apps/web/src/copy/{errors,auth}.ts`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/test/client.test.ts`, `apps/web/test/safe-next.test.ts`, `apps/web/test/auth.test.tsx`

**Interfaces:**
- **Client:**
  - `class ApiError extends Error { status: number; field?: string; latest?: unknown }`
  - `apiFetch<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>`: JSON in and out, `credentials: 'same-origin'`.
    - A non-2xx response becomes an `ApiError` carrying the body's `error`, `field` and `latest`.
    - A `fetch` rejection becomes `ApiError(0, common.networkError)`.
    - A 401 also calls the registered `onUnauthorized()`.
  - `setUnauthorizedHandler(fn: () => void): void`
- **`types.ts`** mirrors the F1/F2 API shapes with exactly these key names:
  - `Account = { user: {id,email,name,emailVerified}; company: {id,name,slug,status}; role: Role; companies: {id,name}[] }`
  - `StepView`, `TaskView` (incl. `rerunOfTaskId`), `ApprovalsList = { count; tasks }`
  - `CompanyBody`, `TeamBody`
  - `SearchResult`, `PinsResult`, `MapArea`, `CurrentWeather`
  - `StepPreview`/`StepResult`/enums are imported from `@roofline/shared` as types.
- **Query keys (`keys.ts`):** `keys.me`, `keys.approvals`, `keys.task(id)`, `keys.summary`, `keys.attention`, `keys.weather`, `keys.mapArea`, `keys.pins(bboxKey)`, `keys.search(q)`, `keys.company`, `keys.team`.
- **Hooks (`hooks.ts`):** `useMe()`, `useSignIn()`, `useSignOut()`, `useSwitchCompany()`.
  - Signing out or switching company clears every query (`queryClient.clear()` after sign-out; `invalidateQueries()` after a switch).
  - Later tasks add their hooks here.
- **`safeNext(raw: string | null): string`** returns `raw` only when it starts with `/`, does not start with `//` or `/\`, and contains no `:` before the first `/`; otherwise `'/'`.
- **Router** (`createBrowserRouter`):
  - Public: `/sign-in`, `/reset` (request form; with `?token=` the new-password form), `/verify?token=`, `/invite?token=`.
  - Everything else sits under `<RequireSession>`, which waits on `useMe()`. On a 401 it redirects to `/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`.
  - Under it, the shell routes from Task 12. For now, an index route renders a placeholder.
  - `setUnauthorizedHandler` points at the same redirect. Repeated 401s while already redirecting are ignored.
- **Providers:** `QueryClientProvider` (defaults: `retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2`, `refetchOnWindowFocus: true`), `ToastProvider`, and `UiLinkProvider` with a React Router `Link` adapter.
- **Pages:**
  - Sign-in: email, password, Sign in, and a "Forgot your password?" link. After success, `navigate(safeNext(next), { replace: true })`.
  - Reset request: always shows "If that email has an account, we sent a link." after submit.
  - Reset with token: new password (≥ 10), then success with a link to sign in.
  - Verify: posts on mount, then shows done, or the API message.
  - Accept invite: name and password (≥ 10) for a new user. When the API says 401 `inviteSignIn`, show its message and a sign-in link carrying `next=/invite?token=…`.
  - Field errors from `ApiError.field` show on that field.

- [ ] **Step 1: Write the failing tests**
  - `safe-next.test.ts`: `/approvals/x` → itself; `/approvals?x=1` → itself; `//evil.example`, `/\\evil.example`, `https://evil.example`, `javascript:alert(1)`, `''` and `null` → `/`.
  - `client.test.ts` (stub `fetch`): a 409 with `{error,latest}` → `ApiError` with status 409 and `latest`; a 400 with `field: 'email'` → `.field`; a fetch rejection → status 0 with the network message; a 401 calls the handler once.
  - `auth.test.tsx` (`createMemoryRouter`):
    - `it('signs in and goes to next')`: at `/sign-in?next=/approvals/t1`, submitting with a stubbed 200 lands on `/approvals/t1`.
    - `it('ignores an unsafe next')`: `next=//evil.example` → `/`.
    - `it('redirects to sign-in with next when the session is gone')`: `/approvals/t1` with `/api/auth/me` → 401 lands on `/sign-in?next=%2Fapprovals%2Ft1`.
    - `it('shows a field error next to the field')`: 401 badLogin is shown in an alert; 400 with `field:'email'` is shown under Email.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the tests, lint and build** — `npx vitest run --project @roofline/web && npm run lint && npm run typecheck && npm run build:web`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): API client, sign-in and email-link pages, session redirect`

---

