### Task 30: Web skeleton for the F3 screens

**Base:** `f3-setup` after `f2-shell` with F2 **T13, T15, T17 and P1** is merged into it again (this task edits `Shell.tsx`, `router.tsx` and `UserMenu.tsx`, which T15 and T17 rewrote; `f3-setup` at `9760679` still has the pre-T17 shell). Current F2 shapes to build on (from `origin/f2-shell`): `Shell.tsx` renders `.topBar` → `ShellTopBar`, `.map` (lazy `MapView` in `Suspense`), `.windows` → `<Outlet/>`, then phone `BottomTabs` + `MoreSheet` or the desktop `Dock`; `Shell.module.css` sets `--shell-top-inset` (65px desktop, 57px phone) and `--shell-bottom-inset` on `.shell`, and windows read them. `Settings.tsx` maps tabs `company`/`team`/else `LaterTab`; `tabs.ts` has `SETTINGS_TABS` and `LaterTabKey`. `UserMenu.tsx`'s trigger holds the `Avatar`. Feature hooks go in `features/<feature>/api.ts` (Ruling Q / plan Ruling 33).
**Owns the F2 hotspots** (`router.tsx`, `Settings.tsx`, `Shell.tsx`, `UserMenu.tsx`): Tasks 31–35 must not edit them.

**Split:**
- Builder 1: `router.tsx`, `Settings.tsx`, `tabs.ts`, `LaterTab.tsx`.
- Builder 2: `Shell.tsx` + `Shell.module.css` (the banner slot), `UserMenu.tsx` (the ring slot), and the eight placeholder components.
- Builder 3: the copy files (`copy/import.ts`, `copy/texting.ts`, `comingSoon` keys in `copy/auth.ts`), the five empty `api.ts` modules, and `apps/web/test/f3-routes.test.tsx` (plus the F2 test updates below).

**Files:**
- Create:
  - `apps/web/src/features/signup/SignUp.tsx`, `features/setup/{SetupTab,SetupRing}.tsx`, `features/billing/{BillingTab,ShellBanners}.tsx`, `features/imports/ImportWizard.tsx`, `features/texting/TextingSetup.tsx`
  - `apps/web/src/features/{signup,setup,billing,imports,texting}/api.ts` (each `export {};`)
  - `apps/web/src/copy/import.ts`, `apps/web/src/copy/texting.ts`
  - `apps/web/test/f3-routes.test.tsx`
- Modify: `apps/web/src/app/router.tsx`, `apps/web/src/features/settings/{Settings.tsx,tabs.ts,LaterTab.tsx}`, `apps/web/src/shell/{Shell.tsx,Shell.module.css}`, `apps/web/src/shell/topbar/UserMenu.tsx` (+ its CSS if needed), `apps/web/src/copy/auth.ts` (append `comingSoon` only), any F2 test that asserted `/settings/billing` or `/settings/setup` show `LaterTab` text.

**Interfaces:**
- **Routes:**
  - Public (beside `/sign-in`): `{ path: '/sign-up', element: <SignUp /> }`.
  - Under the session, before `settings/:tab`: `settings/setup/import`, `settings/setup/import/:importId` → `ImportWizard`; `settings/setup/texting` → `TextingSetup`. All three render inside `<AppWindow app="settings"><Settings …/></AppWindow>` with the Setup tab current: give `Settings` an optional prop `subpage?: ReactNode`; when present the tab is forced to `setup` and the panel shows `subpage` instead of `SetupTab`.
- **Settings tabs:** `billing` → `<BillingTab />`, `setup` → `<SetupTab />`; `connections` keeps `LaterTab`. `LaterTabKey` becomes `'connections'`.
- **Placeholders** (string-free JSX, text from copy):
  - **Proposed Ruling AG:** `BillingTab` renders `<EmptyState title={billing.later} />` and `SetupTab` `<EmptyState title={setup.later} />` (the F2 lines already there), so F2's settings test of those tabs keeps passing until T32/T33 replace them; `SignUp` → `auth.comingSoon` "Sign-up is almost here."; `ImportWizard` → `importCopy.comingSoon` "Importing customers is almost here."; `TextingSetup` → `texting.comingSoon` "Texting registration is almost here." (exact strings; T31–T35 replace them).
  - `SetupRing` and `ShellBanners` render `null`.
- **Copy files:** `copy/import.ts` exports `export const importCopy = { comingSoon: … } as const` (named `importCopy` because `import` is a keyword); `copy/texting.ts` exports `texting`. Unquoted camelCase keys. No vendor names in these two files.
- **Shell banner slot (proposed Ruling AH):** `<div className={styles.banners}><ShellBanners /></div>` sits directly under the top bar on desktop and phone: `position: fixed; top: var(--shell-base-top); left: 0; right: 0; z-index: 25`. Rename the current top-inset values to `--shell-base-top` (65px / 57px) and define `--shell-top-inset: calc(var(--shell-base-top) + var(--shell-banner-height, 0px))`. `Shell` measures the slot with a `ResizeObserver` and sets `--shell-banner-height` (px) on `.shell` via `style`, so windows and map controls move down while a banner shows and come back when it goes (0 when empty). Test-friendly: no `ResizeObserver` in jsdom → skip measuring.
- **UserMenu ring slot:** `<SetupRing />` rendered beside the avatar, outside the menu trigger button (its own link later).
- Keep T15's `useTodayAutoOpen()` call and T17's phone branch exactly as they are.

**Tests (`f3-routes.test.tsx`)** — `createAppRouter({ initialEntries })`, `stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': ACCOUNT })`, `vi.mock` of `MapView` as the shell tests do:
- each new URL renders its placeholder text inside the right window or tab: `/settings/setup/import` and `/settings/setup/import/abc` → the import line inside the dialog "Settings", with the Setup tab link `aria-current="page"`; `/settings/setup/texting` → the texting line; `/settings/billing` → `billing.later`; `/settings/setup` → `setup.later`.
- `/settings/connections` still shows `connections.later`.
- `/sign-up` renders `auth.comingSoon` without a session (`GET /api/auth/me` → 401).
- `expect(api.unexpected).toEqual([])`.

**Verify notes:**
- Web only, no database: `npx vitest run --project @roofline/web && npm run lint && npm run lint:css && npm run typecheck && npm run build:web` (heavy: run through `ops/bin/slot` if the box is busy). The copy-rules test must pass.
- Commit: `feat(web): routes and slots for sign-up, setup, billing, import and texting`.
