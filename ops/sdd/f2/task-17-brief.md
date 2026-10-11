### Task 17: Web: the phone layout (unit-tested part)

Base: `f2-shell` a246d1a. Branch `f2-t17`. Source: plan Task 17 + Ruling H, Ruling N, and the "Carry to Task 12/17" and "Carry to Task 17" ledger lines.

**Scope cut (controller):** no Playwright specs (`phone.spec.ts`, `a11y.spec.ts`), no CI e2e job and no `f2-acceptance.md` now. They come after Task 13's e2e stack exists. Do not touch `.github/workflows/ci.yml` or `docs/`.

**Shared-file rule with the parallel P1 task (branch `f2-p1`):** P1 changes only HOW `MapView` is imported in `Shell.tsx` (`React.lazy` + `Suspense`), moves `Bbox` into `api/types.ts`, and edits `api/hooks.ts`, `SearchDialog.tsx`, `UserMenu.tsx`, `StormWindow.tsx`, `auth.test.tsx`, `eslint.config.js`. T17 must NOT edit those files except `Shell.tsx`, and in `Shell.tsx` must leave the `import { MapView } ...` line and the `<MapView onOpen={open} />` element exactly as they are (wrap around them, do not rewrite them). T17 owns MapView internals (`shell/map/*`) and the shell layout CSS.

**Files**
- Create: `apps/web/src/shell/phone/BottomTabs.tsx`, `BottomTabs.module.css`, `MoreSheet.tsx`, `MoreSheet.module.css`, `apps/web/src/shell/phone/phoneIcons.tsx` (optional), `apps/web/test/phone.test.tsx`, `apps/web/test/map-hit-layers.test.ts`
- Modify: `apps/web/src/shell/Shell.tsx`, `apps/web/src/shell/Shell.module.css`, `apps/web/src/shell/AppWindow.tsx` (only if needed), `apps/web/src/shell/topbar/ShellTopBar.tsx` + `.module.css`, `apps/web/src/copy/shell.ts`, `apps/web/src/shell/map/layers.ts`, `apps/web/src/shell/map/interactions.ts`, `apps/web/src/shell/map/MapView.module.css` (only if needed for long-text/overflow)

**Packages (file-disjoint)**
- **A: phone navigation** — `shell/phone/*`, `copy/shell.ts`, `test/phone.test.tsx`.
- **B: shell layout** — `Shell.tsx`, `Shell.module.css`, `AppWindow.tsx`, `topbar/ShellTopBar.tsx` + css. Consumes `BottomTabs` from A by exact name. Tests for B live in `phone.test.tsx` too, so A writes them; B may add assertions to `apps/web/test/shell.test.tsx` only for desktop regressions.
- **C: pin hit layers (Ruling N)** — `shell/map/layers.ts`, `shell/map/interactions.ts`, `test/map-hit-layers.test.ts` (and existing `test/map-layers.test.ts` / `test/map-interactions.test.ts` updates if their layer-id lists change).

**Interfaces**

*Copy (`copy/shell.ts`, add):*
- `tabsLabel: 'Main'` (nav aria-label)
- `tabMyDay: 'My day'`, `tabMap: 'Map'`, `tabJobs: 'Jobs'`, `tabCalendar: 'Calendar'`, `tabMore: 'More'`
- `moreTitle: 'More'`
- `search: 'Search'` only if the existing SearchDialog does not already carry its own label (it does; do not duplicate).
- Storm, Front Desk, Estimator, Agents and Settings labels in MoreSheet come from `WINDOW_COPY[key].title` (`copy/dock.ts`), not new strings.

*`BottomTabs({ onMore }: { onMore: () => void })`* (named export, `shell/phone/BottomTabs.tsx`):
- `<nav aria-label={shell.tabsLabel}>` containing five items, each at least 48px tall and an equal share of the width: My day → `/today`, Map → `/`, Jobs → `/jobs`, Calendar → `/calendar`, More.
- The four links use `UiLink`/`Button href` from `@roofline/ui` or react-router `Link`/`NavLink` (whatever the existing Dock uses for routing; no raw `<button>`). `aria-current="page"` on the link whose path matches: `/` matches only exactly `/`; others match their first segment.
- More is a `Button` (or `IconButton`) with `aria-haspopup="dialog"` that calls `onMore`. `aria-expanded` reflects the sheet when B passes it (optional prop `moreOpen?: boolean`).
- Icon + label per item; label ≥ 12px; tap target ≥ 48px; `data-*` for state, no class assertions.

*`MoreSheet({ open, onClose }: { open: boolean; onClose: () => void })`* (named export):
- A kit `Sheet` titled `shell.moreTitle` listing links in this order: Storm `/storm`, Front Desk `/front-desk`, Estimator `/estimator`, Agents `/agents`, Settings `/settings`. Each link ≥ 48px tall. Choosing one navigates and calls `onClose`.

*Shell (B):*
- `const phone = useIsPhone()` (exists in `shell/useIsPhone.ts`).
- Phone: no `Dock`; render `<BottomTabs onMore={...} moreOpen={...} />` in a fixed bottom wrapper and `<MoreSheet .../>`. Desktop: unchanged dock.
- **Insets, not magic numbers.** `.shell` defines `--shell-top-inset` and `--shell-bottom-inset` on the root element that contains the outlet (so the kit Window inherits them):
  - desktop: `--shell-top-inset: 65px` (top bar 57 + 8), `--shell-bottom-inset: 94px` (dock 16 + 70 + 8);
  - phone (`@media (max-width: 767.98px)`): `--shell-top-inset` = the compact top bar height (57px unless the compact bar differs), `--shell-bottom-inset` = the bottom tab bar height (48px + `env(safe-area-inset-bottom, 0px)`).
  - Replace the hard-coded `65px` / `94px` in the floating-window rule with `var(--shell-top-inset)` / `var(--shell-bottom-inset)`. No other literal 72/96/65/94 offsets remain in `Shell.module.css` (`grep -nE '\b(65|72|94|96)px' apps/web/src/shell/Shell.module.css` prints nothing).
  - Because the kit's floating rule already uses `--shell-bottom-inset` only for `page`, the floating desktop rule must set `top: var(--shell-top-inset); bottom: var(--shell-bottom-inset)` explicitly.
- **One fixed inset wrapper:** the outlet sits inside a single `<div className={styles.windows}>` (no position/transform/z-index of its own, so the Window still compares with the dock in the page stacking context) — this is where the inset variables are set if not on `.shell`.
- **Page window under the top bar on phone:** `.shell [role="dialog"][data-variant="page"] { top: var(--shell-top-inset); bottom: var(--shell-bottom-inset); }` so a phone window starts below the compact top bar and stops above the tabs. Selector specificity must beat the kit's `.window[data-variant="page"]` (0,2,0).
- **z-index:** dock (desktop) and the bottom tabs wrapper (phone) 30; top bar stays 25; Window 20, Sheet 40, toasts 50 come from the kit. The comment at the top of `Shell.module.css` is updated to list the bottom tabs.
- **No horizontal scroll at 375px:** the shell root and the outlet wrapper never exceed the viewport (`max-width: 100vw`, `overflow-x: clip` on `.shell` is acceptable); long company names ellipsize.

*Compact top bar (B, `ShellTopBar`):* on phone render: logo, `OkPill`, `SearchDialog`, `UserMenu`. Hide `AgentsWorking`, `WeatherChip` and the company name (do not render them on phone; use `useIsPhone`, not CSS display:none, so they make no requests). Desktop unchanged.

*AppWindow:* already renders `variant="page"` on phone; keep it. Only change if needed.

*Pin hit layers (C, Ruling N):*
- `LAYER.customersHit = 'customers-hit'`, `LAYER.jobsHit = 'jobs-hit'`: circle layers on the same sources/filters as `customers`/`jobs`, `circle-radius: 20` (40px diameter), `circle-opacity: 0`, `circle-stroke-opacity: 0`, added right AFTER the visible pin layer of the same source (so they are on top), and listed in `LAYER_IDS` and in `removePinGroup` (so removal leaves none behind and a clustering rebuild re-adds them).
- `interactions.ts`: the click and cursor bindings for single pins target the hit layers (`LAYER.customersHit`, `LAYER.jobsHit`) instead of the 7px visible layers. Cluster bindings unchanged.
- **Nearest-feature pick:** when a click's `event.features` holds several pins (overlapping hit circles), pick the one whose point is nearest the click in screen pixels: `map.project(lngLat)` vs `event.point`. Export `nearestFeature(features, point, project): MapGeoJSONFeature | undefined` from `interactions.ts` for testing. A single click hitting both a customer and a job hit layer must open only one pin: bind one `click` listener without a layer filter (or on both hit layers) that queries `map.queryRenderedFeatures(event.point, { layers: [LAYER.customersHit, LAYER.jobsHit] })` and opens the nearest — choose one approach and make sure a single click never calls `onPick` twice.

**Tests (exact)**

`apps/web/test/phone.test.tsx` (stub `matchMedia` to match `(max-width: 767.98px)`; mock `../src/shell/map/MapView.tsx` like `shell.test.tsx` does; use `test/helpers.tsx` `stubApi`/`SHELL_ROUTES`/`renderAt`; import `RouterProvider` from `'react-router'`):
- `it('shows five bottom tabs and no dock on a phone')`: `getByRole('navigation', { name: 'Main' })` holds 4 links (My day, Map, Jobs, Calendar) + 1 button More = 5 items; `queryByRole('navigation', { name: <dock.label> })` is null.
- `it('marks the current tab')`: at `/jobs`, the Jobs link has `aria-current="page"`; Map does not. At `/`, Map has it.
- `it('More opens a sheet with five links')`: click More → `getByRole('dialog', { name: 'More' })` contains links named Storm, Front Desk, Estimator, Agents, Settings (exactly 5 links), hrefs `/storm`, `/front-desk`, `/estimator`, `/agents`, `/settings`.
- `it('choosing a More link closes the sheet and navigates')`: click Storm → `where(router)` is `/storm` and the More dialog is gone.
- `it('windows are pages on a phone')`: at `/jobs` the window dialog has `data-variant="page"`.
- `it('the compact top bar hides the agents line and the weather')`: on phone no `AgentsWorking` text ("All quiet") and no weather request is made (`/api/weather` not called); OkPill and the Search button are present.
- `it('desktop keeps the dock and no bottom tabs')`: matchMedia not matching → dock nav present, `navigation` named Main absent.

`apps/web/test/map-hit-layers.test.ts` (fake map object like `map-layers.test.ts`):
- `installMapLayers` adds `customers-hit` and `jobs-hit` with `paint['circle-radius'] === 20` and `paint['circle-opacity'] === 0`, each after its visible layer in add order.
- `removeMapLayers` removes both; `updateMapData` with a clustering change re-adds both.
- `nearestFeature([a at 0,0px, b at 5,5px], point {x:4,y:4}, project)` returns `b`; empty list returns `undefined`.
- a click hitting both hit layers calls `onPick` exactly once with the nearer pin.

Existing tests (`shell.test.tsx`, `map-layers.test.ts`, `map-interactions.test.ts`, `top-bar.test.tsx`) must stay green; update their expectations only where the layer-id lists or bindings legitimately changed.

**Verify:** `ops/bin/slot npx vitest run --project @roofline/web && ops/bin/slot npm run typecheck && ops/bin/slot npm run lint && ops/bin/slot npm run lint:css && ops/bin/slot npm run build:web`

**Commit:** `feat(web): phone layout with bottom tabs, inset variables and 40px pin hit layers`
