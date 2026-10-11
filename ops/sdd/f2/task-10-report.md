# Task 10 report: Web API client, auth pages, router skeleton

Status: DONE (with concerns listed below)
Worktree: `/Users/parsasalahshori-a/RooflineWork/wt/t10`, branch `f2-t10`
Commit: `2759c9e feat(web): API client, sign-in and email-link pages, session redirect` (ends with the Claude Opus 5.5 co-author line; includes package-lock.json)

## What was implemented

**API layer (`apps/web/src/api/`)**
- `client.ts`: `ApiError(status, message, field?, latest?)`; `apiFetch<T>(path, { method, body, signal, redirectOn401 })`; `setUnauthorizedHandler`.
  - JSON in and out, `credentials: 'same-origin'`; `Content-Type` only when there is a body.
  - Non-2xx becomes an `ApiError` with the body's `error`, `field`, `latest`. When there is no usable `error` string (a 502 with an HTML or empty body), the message is `errors.generic`.
  - A `fetch` rejection becomes `ApiError(0, common.networkError)`.
  - A 401 calls the registered handler once, unless the call passed `redirectOn401: false`.
  - An empty 2xx body resolves to `undefined`. A 2xx body that is not JSON (a web page served in place of the API) becomes `ApiError(status, errors.generic)`.
  - An `AbortError` is re-thrown as is. It is not a lost connection, and react-query cancels queries that way.
- `types.ts`: `Account`, `User`, `CompanySummary`, `SignInResult`, `StepView`, `TaskView`, `ApprovalsList`, `CompanyBody`, `TeamBody`, `SearchResult`, `PinsResult`, `MapArea`, `CurrentWeather`, exactly as specified. Enums and `StepPreview`/`StepResult` are `import type` from `@roofline/shared`. Company `status` is typed `CompanyStatus`.
- `keys.ts`: `me`, `approvals`, `task(id)`, `summary`, `attention`, `weather`, `mapArea`, `pins(bboxKey)`, `search(q)`, `company`, `team`.
- `hooks.ts`:
  - `useMe` (`staleTime` 30s, so the many parts of a screen share one answer).
  - `useSignIn` (`redirectOn401: false`; clears the cache on success so nothing from a previous session survives).
  - `useSignOut` (a 401 from logout counts as signed out; `queryClient.clear()`, then navigates to `/sign-in`).
  - `useSwitchCompany` (`setQueryData(me)`, then invalidates every other query).

**App (`apps/web/src/app/`)**
- `providers.tsx`: `createQueryClient()` with the specified `retry` and `refetchOnWindowFocus: true`. `Providers({ children, client? })` wraps `QueryClientProvider`, `ToastProvider closeLabel={common.close}` and `UiLinkProvider` with a module-level `RouterLink` adapter (href to `to`).
- `RequireSession.tsx`:
  - A `Skeleton` inside a `role="status"` region (with visually-hidden text) while `useMe` loads.
  - A 401 renders `<Navigate to="/sign-in?next=..." replace />`.
  - Cached data keeps rendering `<Outlet />`.
  - Any other failure (network, 5xx) shows an `EmptyState` with the message and a "Try again" button.
  - Exports `redirectToSignIn(router)` and `resetSignInRedirect()`. The module-level "already redirecting" flag lives here; `SignIn` clears it on mount.
- `router.tsx`: `createAppRouter(opts?: { initialEntries })` returns a memory router when `initialEntries` is given, otherwise a browser router. It resets the redirect flag and registers `setUnauthorizedHandler(() => redirectToSignIn(router))`.
  - Public routes: `/sign-in`, `/reset`, `/verify`, `/invite`.
  - The session route has an index child and a `*` child, both rendering a placeholder `<h1>{common.appName}</h1>`. The `*` child is needed because `/approvals/t1` must reach `RequireSession` for the redirect test.
- `main.tsx`: `Providers` + `RouterProvider` (from `react-router/dom`).

**Pages (`apps/web/src/features/auth/`)**
- `SignIn`:
  - Centered `Card` with the app name, `Field` inputs and `Button type="submit" busy`.
  - The forgot link is `Button href="/reset"`.
  - On success it runs `navigate(safeNext(next), { replace: true })`.
- `ResetPassword`:
  - Without a token: the request form. After success it always shows "If that email has an account, we sent a link."
  - With `?token=`: the new-password form, then a success message and a sign-in link.
  - A dead link (400 with no field) shows the API message and an "Ask for a new link" button.
- `VerifyEmail`: POSTs once on mount, guarded by a ref so a StrictMode double effect does not spend the single-use link twice. Shows done plus Continue, or the API message. No token shows the "link is incomplete" message and sends nothing.
- `AcceptInvite`:
  - Name and password form. Success does `clear()`, `setQueryData(me, body)` and `navigate('/')`.
  - 401 shows the API message and a "Sign in to join" link to `/sign-in?next=%2Finvite%3Ftoken%3D...`.
  - 409 shows the message and a Continue link.
- `safeNext.ts`, `formErrors.ts` (splits an `ApiError` into a per-field message and a general alert; `ApiError.field` shows on that field), `AuthLayout.tsx` (card layout plus `FormAlert`).
- Copy: `copy/errors.ts` created (`generic`, `tryAgain`). `copy/auth.ts` modified, with new keys added after the existing five.

## Tests and results

Final run: `npx vitest run --project @roofline/web` gives 6 files, 84 tests, all passing (new: safe-next 14, client 12, auth 26; the other 3 files are the existing Task 1/2 suites). Repeated 6 times, stable.

Also green from the worktree root: `npm run lint`, `npm run lint:css`, `npm run typecheck` (tsc -b, includes the tests), `npm run build:web`.

Brief tests, all present: the safe-next table; the client's 409+latest, 400 field, fetch rejection, and 401-calls-handler-once; auth: signs in and goes to next, ignores an unsafe next, redirects to sign-in with next, shows a field error next to the field (a 401 badLogin sits in a `role="alert"` element, a 400 `field:'email'` is the Email field's accessible description and sets `aria-invalid`).

Extra coverage added:
- `redirectOn401: false`, abort pass-through, non-JSON error and success bodies.
- The redirect guard unit-tested against a fake router (once, then again after `resetSignInRedirect`), plus an integration test with three concurrent 401s.
- No redirect when already on a public page.
- Reset request and reset with a token (field error, dead link), verify (StrictMode single POST, 400, no token), accept invite (success keeps the session, 401 link, 400/409, field errors, no token), sign-out and company-switch hooks.

TDD evidence:
- RED (before any source existed), `npx vitest run --project @roofline/web`:
  ```
  FAIL test/auth.test.tsx    Failed to resolve import "../src/app/providers.tsx"
  FAIL test/client.test.ts   Failed to resolve import "../src/api/client.ts"
  FAIL test/safe-next.test.ts Failed to resolve import "../src/features/auth/safeNext.ts"
  Test Files  3 failed | 3 passed (6)   Tests  30 passed (30)
  ```
- GREEN (final): `Test Files 6 passed (6)   Tests 84 passed (84)`.
- Mutation checks that the tests bite:
  - Removing the StrictMode `sent` ref makes the verify test fail (two POSTs).
  - Removing the `redirecting ||` guard makes the guard unit test fail. The integration test alone did not catch this, because the public-path check also stops later calls once navigation completes synchronously; that is why the direct unit test exists.

Visual smoke: a production build served with `vite preview` showed the sign-in card and, with no API behind it, the "Try again" error panel from `RequireSession` after its retries.

## Files changed

Created:
- `apps/web/src/api/{client,types,keys,hooks}.ts`
- `apps/web/src/app/{router,providers,RequireSession}.tsx`
- `apps/web/src/app/RequireSession.module.css`
- `apps/web/src/features/auth/{SignIn,ResetPassword,VerifyEmail,AcceptInvite,AuthLayout}.tsx`
- `apps/web/src/features/auth/{safeNext,formErrors}.ts`
- `apps/web/src/features/auth/Auth.module.css`
- `apps/web/src/copy/errors.ts`
- `apps/web/test/{client,safe-next}.test.ts`, `apps/web/test/auth.test.tsx`

Modified: `apps/web/src/main.tsx`, `apps/web/src/copy/auth.ts`, `apps/web/package.json`, `package-lock.json`.

Dependencies: `react-router@^7.18.4` and `@tanstack/react-query@^5.104.1` (dependencies); `@testing-library/{react,user-event,dom}` (devDependencies). npm created `node_modules/react-router/node_modules/cookie`; I ran `xattr -w 'com.apple.fileprovider.ignore#P' 1` on it.

## Self-review findings and decisions

- **Extra files beyond the brief's list**, all inside my own feature folders so they cannot collide with sibling tasks: `AuthLayout.tsx`, `formErrors.ts`, `Auth.module.css`, `RequireSession.module.css`. The brief lists none of them but the pages need shared layout and CSS.
- **`safeNext` is stricter than the brief by one rule**: it also refuses control characters (tab, CR, LF), because browsers strip them, so `/<tab>/evil.example` would become `//evil.example`. The brief's "no `:` before the first `/`" is implied by "starts with `/`", so there is no separate check for it.
- **Public-path guard in the 401 handler**: the handler does nothing when the router is already on `/sign-in`, `/reset`, `/verify` or `/invite`. Without it, a late 401 after sign-out would produce `/sign-in?next=/sign-in`.
- **Reset-request error handling**: success always shows the "we sent a link" text, whoever the address is. A failure (invalid address 400 with `field: 'email'`, 429, network) shows the error instead; showing "we sent a link" for a rate-limited or malformed request would be false.
- **Password length (≥ 10)** is enforced by the server and shown next to the field from `ApiError.field`, with a help line on the field. There is no duplicate client-side check, so the rule cannot drift from the server. This also avoids blocking an existing account holder's (possibly short seed) password on the invite page.
- **Non-field errors on the auth pages are inline `role="alert"` messages**, not toasts, because those pages are forms outside the shell. The toast provider is mounted for the shell tasks. Note `ToastProvider` always renders an empty `role="alert"` region, so a test that does `getByRole('alert')` will find two; mine find the message text and check its `closest('[role="alert"]')`.
- Auth tests call `cleanup` and `unstubAllGlobals` themselves in `afterEach`, because Vitest globals are off and RTL's auto-cleanup does not register. I did not touch the shared `test/setup.ts`.

## Concerns

1. **Dual-package hazard in Vitest**: `react-router` and `react-router/dom` load as two separate copies under Vitest. The router context from `react-router/dom`'s `RouterProvider` is then not seen by `useNavigate` from `react-router`, so the whole auth suite failed until the tests used `RouterProvider` from `react-router`. Production code (`main.tsx`) uses `react-router/dom`, and the Vite build resolves both to the same ESM copy. Task 11/12 tests must import `RouterProvider` from `'react-router'`, not `'react-router/dom'`. An alternative is `test.server.deps.inline: ['react-router']` in `apps/web/vitest.config.ts`; I did not change that config.
2. **No `errorElement` on the routes**: a render crash shows React Router's default developer-facing error page. Task 12 or later should add one.
3. **Placeholder routes**: Task 12 should replace the index/`*` placeholder children under the session route.
4. **Unverified against a live API**: only fetch stubs were used, with the message and status shapes copied from `apps/api/src/auth/routes.ts` and `errors.ts`.

---

# Review and finalize pass (Sonnet lead)

Commit: `a7fa178 fix(web): review fixes for the API client and auth pages` on `f2-t10` (on top of `2759c9e`). Ends with the Claude Opus 5.5 co-author line, as the task asked.

## What was built, and by which packages

- Build: `2759c9e` by the Sonnet implementer (see the report above).
- Review fixes: the review rounds left changes in two files. The package split follows the files.
  - Types package, `apps/web/src/api/types.ts`: `TaskView.summary` is now `string | null` and `TaskView.minutesSaved` is `number | null`. This matches `TaskView` in `apps/api/src/tasks/service.ts` (`summary: string | null`, `minutesSaved: number | null`, set only when a plan finishes).
  - Tests package, `apps/web/test/auth.test.tsx`:
    - `vi.setConfig({ testTimeout: 30_000 })` and `configure({ asyncUtilTimeout: 10_000 })`, because on a busy machine the defaults (5 s per test, 1 s per `findBy`) time out, and a timed-out test keeps typing into the next test's page.
    - New test: "offers another try when the session check fails for a reason other than a lost session". A 500 on `/api/auth/me` shows the message in a `role="alert"` region, keeps the person on `/jobs`, does not open the page behind it, and the "Try again" button recovers once the API answers.
    - New test: "retries a failed read twice, but never one the server refused with a 4xx". It checks the `retry` default for 404 and 401 (no retry), 500 and status 0 (retry), a plain `TypeError` (retry), a third failure (stop), and `refetchOnWindowFocus: true`.

## Review rounds

The finding texts were not passed to this run, only the counts and the contact verdicts. The mapping of each finding to a file below is inferred from the diff, not quoted from the findings.

| Round | Findings | Contact check | Outcome |
|---|---|---|---|
| Review 1 | 2 (F1, F2) | F1 approve, F2 amend | Both applied (F2 in its amended form) |
| Review 2 | 1 (F3) | F3 approve | Applied |
| Review 3 | 0 | none needed | Clean; no further changes |

- Fixed: 3 of 3. Rejected: none.
- This final pass changed no source or test code. It only ran the full verification and committed the working-tree fixes.

## Minors (carried, not fixed here)

- No `errorElement` on the routes; a render crash shows React Router's developer-facing page. Task 12 or later.
- The index and `*` placeholder routes under `RequireSession` are for Task 12 to replace.
- Under Vitest, `react-router` and `react-router/dom` load as two copies, so tests import `RouterProvider` from `'react-router'`. An alternative for later is `test.server.deps.inline: ['react-router']` in `apps/web/vitest.config.ts`.
- Auth flows are checked only against fetch stubs, not a live API.

## Verify output tail

Command, from the worktree root: `npx vitest run --project @roofline/web && npm run lint && npm run lint:css && npm run typecheck && npm run build:web`. Exit 0, no changes needed to pass.

```
 Test Files  6 passed (6)
      Tests  86 passed (86)
   Duration  21.07s

> eslint .                     (clean)
> stylelint ...                (clean)
> tsc -b                       (clean)
> vite build
✓ 128 modules transformed.
dist/index.html                   0.39 kB │ gzip:   0.26 kB
dist/assets/index-CofAlnV-.css    6.77 kB │ gzip:   2.02 kB
dist/assets/index-D4aMjAsU.js   365.81 kB │ gzip: 114.39 kB
✓ built in 1.48s
```
