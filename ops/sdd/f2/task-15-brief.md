### Task 15: Web: Today window

**Base:** `f2-shell` after T16 is merged (it needs `useCompany` from `apps/web/src/features/settings/api.ts`). The API it calls, `POST /api/me/today-shown` → `{ show: boolean }`, is T6's (`apps/api/src/auth/me.ts` on `f2-t6`); the unit tests stub `fetch`, so T6 need not be merged first.
**Ruling P:** no Playwright spec here (`today.spec.ts` is T18's). **Ruling Q:** the new hooks go in `apps/web/src/features/today/api.ts`, not `api/hooks.ts`.

**Split:**
- Builder 1: `features/today/api.ts`, `features/today/useTodayAutoOpen.ts`, the one-line `Shell.tsx` change, the `today` route in `router.tsx`, and the `SHELL_ROUTES` line in `test/helpers.tsx`.
- Builder 2: `features/today/Today.tsx`, `Today.module.css`, `copy/today.ts`.
- Builder 3: `test/today.test.tsx`.

**Files:**
- Create: `apps/web/src/features/today/{api.ts,useTodayAutoOpen.ts,Today.tsx,Today.module.css}`, `apps/web/src/copy/today.ts`, `apps/web/test/today.test.tsx`
- Modify: `apps/web/src/shell/Shell.tsx` (one call: `useTodayAutoOpen();` at the top of `Shell`), `apps/web/src/app/router.tsx` (route `today`), `apps/web/test/helpers.tsx` (`SHELL_ROUTES` gains `'POST /api/me/today-shown': () => ({ body: { show: false } })`)

**Interfaces:**
- **`features/today/api.ts`:**
  - `useTodayShown()`: `useMutation({ mutationFn: () => apiFetch<{ show: boolean }>('/api/me/today-shown', { method: 'POST' }) })`. No query key (it writes).
  - Reuse, do not copy: `useCompany` (from `../settings/api.ts`), `useMe` and `useApprovals` (from `../../api/hooks.ts`), `countedDrafts` (from `../../shell/countedDrafts.ts`).
- **`useTodayAutoOpen(): void`** (the plan's "auto-open"):
  - Captures `useLocation().pathname` at **first render** in a ref (`useRef(pathname)` — later navigation does not change it).
  - A second ref `asked` guards StrictMode's double effect.
  - In an effect on `me.data`: when `me.data` is defined, `asked.current` is false and the first path was exactly `'/'` → set `asked.current = true`, `mutate()`; `onSuccess: ({ show }) => { if (show) void navigate('/today'); }`. Errors are ignored (no toast — Today is a nicety).
  - A deep link (first path anything but `/`) never POSTs.
  - Lives outside `Shell.tsx` so T17's phone rewrite of `Shell.tsx` only has to keep one line.
- **Route:** `{ path: 'today', element: <AppWindow app="today"><Today /></AppWindow> }`, placed before the `*` NotFound route. `WINDOW_COPY.today` ("My day" / "What needs you today") already exists in `copy/dock.ts`.
- **`copy/today.ts`** (`export const today = { … } as const`):
  - `greeting: (part: 'morning' | 'afternoon' | 'evening', firstName: string) => firstName ? \`Good ${part}, ${firstName}\` : \`Good ${part}\``
  - `needYourOk: 'Need your OK'`, `nothingNeedsYou: 'Nothing needs your OK right now.'`, `seeAll: (n: number) => \`See all ${n}\``
  - `appointments: "Today's appointments"`, `noAppointments: 'No appointments yet. Your calendar is coming soon.'`
  - `draftsLabel: 'Plans waiting for your OK'` (accessible name of the list)
- **`Today`:**
  - **Part of day:** `partOfDay(now: Date, timeZone: string): 'morning' | 'afternoon' | 'evening'` (exported from `Today.tsx` or a sibling `partOfDay.ts` in the same folder): hour from `Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone })`; `< 12` morning, `< 17` afternoon, else evening. `timeZone` is `useCompany().data?.timezone`; until it loads use the browser zone (`undefined`).
  - **Heading:** an `h2` with `today.greeting(part, firstName)`, `firstName` = first whitespace-separated word of `me.data.user.name`.
  - **Date line:** `new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone }).format(now)`.
  - **"Need your OK" section** (`section` with `aria-labelledby` its `h3`): `countedDrafts(useApprovals().data)` sorted newest `createdAt` first, top 3, each a `Card` link (`href={'/approvals/' + encodeURIComponent(id)}`) showing `AGENT_LABEL[task.agent]` and `task.title`. None → `today.nothingNeedsYou`. More than 3 → a `Button variant="ghost" href="/approvals"` reading `today.seeAll(total)`.
  - **"Today's appointments" section:** `EmptyState` with title `today.noAppointments`.
  - All text from `copy/today.ts`, `copy/status.ts`; no literal JSX text, no raw `<button>`. Long titles ellipsize (`min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`).
- **Reopening:** the user menu's "My day" item (`/today`) already exists (T12).

**Tests (`test/today.test.tsx`)** — use `stubApi`, `SHELL_ROUTES`, `makeTask`, `ACCOUNT` from `./helpers.tsx`; mock `../src/shell/map/MapView.tsx` as `auth.test.tsx` does; mount `createAppRouter({ initialEntries })` under `Providers` with `RouterProvider` from `react-router`. Add `'GET /api/auth/me'` → `ACCOUNT` with `user.name: 'Dana Ruiz'`, and `'GET /api/company'` → a `CompanyBody` with `timezone: 'America/Chicago'`.
- `it('greets by first name in the company time zone')`: `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-12T14:00:00Z'))` (09:00 in Chicago), start at `/today` → heading `Good morning, Dana`; date line `Monday, October 12`. Restore real timers in `afterEach`.
- `it('lists the top 3 drafts')`: `/api/approvals` → 5 drafts (`makeTask`, distinct `createdAt`) → 3 links inside the "Need your OK" section, newest first, and a link `See all 5` to `/approvals`.
- `it('says when nothing needs an OK')`: 0 drafts → `Nothing needs your OK right now.`
- `it('auto-opens only from the map home')`:
  - initial `/` with `'POST /api/me/today-shown'` → `{ show: true }` → `waitFor(where(router) === '/today')`, `api.count('POST /api/me/today-shown') === 1` (also under `<StrictMode>`).
  - initial `/` with `{ show: false }` → stays `/`.
  - initial `/jobs` → after the Jobs dialog shows, `api.count('POST /api/me/today-shown') === 0`.
- Every test ends with `expect(api.unexpected).toEqual([])`.

**Verify notes:**
- Run focused files only: `npx vitest run --project @roofline/web today shell auth` (the `SHELL_ROUTES` change must keep `shell.test.tsx` and `auth.test.tsx` green — both render `/` and now see the POST), then `npm run lint && npm run lint:css && npm run typecheck`. The web project needs no database.
- Commit: `feat(web): Today window, once per day per person`.
