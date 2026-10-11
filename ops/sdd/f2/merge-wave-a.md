# Merge plan for F2 team wave A (Opus contact 1 group check)

## Merge notes

Recommended order: T10 (f2-t10 @ a7fa178), then T11 (f2-t11 @ 3790d81), then T12 (f2-t12 @ c948f3f), each merged --no-ff into f2-shell (currently at f3b43ad). I checked this order in a scratch clone of the repo (worktrees and branches untouched). T10 and T11 merge onto f2-shell with no conflicts (package-lock.json auto-merges). T12 then produces exactly three conflicts, listed below. If the controller merges T12 before T11, the same three conflicts appear in the T11 merge with the sides swapped; for MapView.tsx keep the f2-t11 side.

Conflict 1, apps/web/src/shell/map/MapView.tsx (add/add):
- Keep T11's real map, i.e. the f2-shell side once T11 is in: `git checkout --ours -- apps/web/src/shell/map/MapView.tsx`, or `git show f2-t11:apps/web/src/shell/map/MapView.tsx > apps/web/src/shell/map/MapView.tsx`.
- T12's stub must lose. The props are compatible: T11's `{ onOpen: (target: PinTarget) => void }` and T12's `onOpen(target: { kind: 'customer' | 'job'; id: string })`. Nothing imports `MapViewProps`.
- Keep T12's `vi.mock('../src/shell/map/MapView.tsx', ...)` blocks in auth.test.tsx and shell.test.tsx. Without them the real map loads maplibre-gl in jsdom and requests /api/map/*, which the stubs reject.

Conflict 2, apps/web/src/api/hooks.ts (three interleaved hunks; git lines up the shared closing `});` lines, so do not merge it hunk by hunk):
- Take T11's file whole: `git checkout --ours -- apps/web/src/api/hooks.ts`. It already has line 1 `import { keepPreviousData, useMutation, useQuery, useQueryClient } ...` and `import type { Bbox } from '../shell/map/types.ts';`.
- Replace the types import with `import type { Account, ApprovalsList, CurrentWeather, MapArea, PinsResult, SearchResult, SignInResult, TaskView } from './types.ts';`.
- Append a blank line plus T12's block: `git show f2-t12:apps/web/src/api/hooks.ts | sed -n '/^\/\*\* How often the shell/,$p' >> apps/web/src/api/hooks.ts`. That block is COUNTS_EVERY, WEATHER_EVERY, useApprovals, useTasksSummary, useAttentionCount, useWeather and useSearch.
- Result: 11 exported hooks (useMe, useSignIn, useSignOut, useSwitchCompany, useMapArea, useMapPins, plus T12's five).
- keys.ts is untouched by T11 and T12 and needs nothing.

Conflict 3, apps/web/test/auth.test.tsx (one hunk, right after `import { common } from '../src/copy/common.ts';`):
- Keep both sides, in this order:
  - `import { dock } from '../src/copy/dock.ts';`
  - `import { errors } from '../src/copy/errors.ts';`
  - `import { SHELL_ROUTES } from './helpers.tsx';`
  - T12's `vi.mock(MapView)` block
  - T10's `vi.setConfig({ testTimeout: 30_000 }); configure({ asyncUtilTimeout: 10_000 });` with its comment.
- The rest of the file auto-merges: T10's `configure`, `QueryClient`, `ApiError` imports and new tests, and T12's `stubApi(given)` that spreads SHELL_ROUTES and returns the merged `routes` (so the new test's `api.routes[...] = ` still works).
- Required semantic edit in the same file: T10's new test 'offers another try when the session check fails for a reason other than a lost session' must swap its two `heading`/`common.appName` lookups for `navigation`/`dock.label` (issue 1).

Required edit with no textual conflict:
- apps/web/test/shell.test.tsx:156: `screen.getByText(plan.summary ?? '')`. Otherwise `tsc -b` fails with TS2769 after T10's nullable summary (issue 2).

Files that merge cleanly, for the record:
- router.tsx (T12 only)
- types.ts (T10 fix only)
- vite-env.d.ts, copy/map.ts, shell/map/* (T11 only)
- vitest.config.ts, test/setup.ts, test/helpers.tsx (T12 only)
- apps/web/package.json and package-lock.json (T11 only: maplibre-gl ^5.24.0, @types/geojson)
- New copy files are disjoint. copy/legal.ts was not changed (T11 reused `legal.mapAttribution`).

Verified result (scratch clone, after the resolutions plus the two edits above):
- `tsc -b apps/web`: clean.
- `eslint apps/web`: clean.
- stylelint on apps/web CSS: clean.
- `vitest run --project @roofline/web`: 18 files, 203 tests pass.
- `vite build`: passes; the 1,429 kB chunk warning is issue 3.
- Without the auth.test edit, that one test fails. Without the shell.test edit, the typecheck fails.
- The controller should still run the full repo suite (`npm run lint && npm run lint:css && npm run typecheck && npx vitest run && npm run build:web`). The known rep-visibility.test.ts:400 flake is unrelated.

After the merge:
- Run `npm install` in the integration checkout, since maplibre-gl is new there.
- Then apply `xattr -w com.apple.fileprovider.ignore#P 1` to any nested node_modules it creates. Per T11's lockfile these are `node_modules/@maplibre/maplibre-gl-style-spec/node_modules` and `node_modules/@maplibre/vt-pbf/node_modules`, plus `apps/web/node_modules` and `node_modules/react-router/node_modules` (from T10) if they appear.
- If later merges (T6/T7/T8) conflict on package-lock.json, regenerate it with `npm install` rather than hand-editing.

Other notes:
- The harness lists T11 as open-findings, but its worktree is clean and its report says 8 of 8 findings fixed. Settle or explicitly accept those findings before merging; none of the resolutions above depend on them.
- Commit trailers: 3790d81 (T11) and c948f3f (T12) end with 'Co-Authored-By: Claude Sonnet 5.5'; a7fa178 (T10) ends with Opus 5.5. Do not rewrite the branches. If the Opus convention matters, put the Opus trailer on the --no-ff merge commits.
- Cross-task interfaces check out:
  - MapView onOpen -> Shell navigates to `/customers/<customerId>` or `/jobs/<jobId>` (T11's customer feature id is customerId), matching the T12 routes `customers/*` and `jobs/*`.
  - T12 uses T10's useMe, useSignOut and useSwitchCompany (mutate(companyId)), ApiError.message toasts, the Button/Pill/Dock href links through T10's RouterLink adapter, and ToastProvider.
  - The query keys T11 and T12 use all exist in T10's keys.ts.
  - T11's summary copy produces exactly T13's expected 'Map showing 70 customers and 25 open jobs.'
  - Copy rules hold: no banned words, enum tokens or vendor names in the new copy, no raw <button> in src, and no letter-containing literal UI text in JSX (lint is clean).
- Heads-up for the next wave: Tasks 14, 15 and 16 all add children to the Shell route array in router.tsx and append to hooks.ts, and Tasks 15 and 17 edit Shell.tsx. Expect the same append conflicts; resolve by union, as with hooks.ts above.

## Issues

- [important] tasks [10, 12]: T10's fix commit a7fa178 adds the test 'offers another try when the session check fails for a reason other than a lost session' (auth.test.tsx, describe 'the session redirect'). It looks for the placeholder `<h1>{common.appName}</h1>`, which T12 removes from router.tsx. The test sits outside the conflict region, so git merges it silently, and it then fails. Seen in a scratch-clone merge: 'Unable to find role="heading" and name "Roofline"' after 10 s. The negative assertion `queryByRole('heading', { name: common.appName })` also becomes vacuous.
  - Suggestion: While resolving auth.test.tsx in the T12 merge, change both assertions in that test the same way T12 changed the other five: `expect(screen.queryByRole('navigation', { name: dock.label })).not.toBeInTheDocument();` and `expect(await screen.findByRole('navigation', { name: dock.label })).toBeInTheDocument();`. Keep `common`: line 170 still uses `common.networkError`. With this change the merged web suite passes (18 files, 203 tests).
- [important] tasks [10, 12]: T10's a7fa178 changes `TaskView.summary` to `string | null` and `minutesSaved` to `number | null`. T12 was built on 2759c9e, where both were non-null. After the merge, `apps/web/test/shell.test.tsx:156` `expect(screen.getByText(plan.summary))` fails `tsc -b` with TS2769 ('string | null' is not assignable to 'Matcher'). Confirmed in the scratch clone. Separately, `StormWindow.tsx:28` renders an empty `<p>` when a storm plan has no summary yet.
  - Suggestion: In the merge commit, change shell.test.tsx:156 to `screen.getByText(plan.summary ?? '')`, or give `makeTask` a local `summary` const and assert on that. As a follow-up, StormWindow should render the summary only when present: `{plan.summary ? <p>{plan.summary}</p> : null}`. helpers.tsx `makeTask` (`summary: '...'`, `minutesSaved: 0`) still typechecks.
- [minor] tasks [11, 12]: Once T12's Shell mounts T11's MapView, maplibre-gl lands in the single entry chunk. The merged `vite build` grows from about 390 kB to 1,429 kB JS (399 kB gzipped), with Vite's >500 kB chunk warning. The sign-in, reset, verify and invite pages now download the whole map library. The build still passes.
  - Suggestion: Follow-up: in Shell.tsx load the map lazily, e.g. `const MapView = lazy(() => import('./map/MapView.tsx').then((m) => ({ default: m.MapView })))` inside `<Suspense fallback={null}>`. The `vi.mock('../src/shell/map/MapView.tsx')` in the tests still applies to a dynamic import. Or split maplibre-gl into its own chunk.
- [minor] tasks [10, 11, 12]: Switching company (T12 UserMenu, then T10 `useSwitchCompany`) only invalidates the non-me queries. T11's `useMapPins` uses `keepPreviousData`, MapView keeps the last good answer in `shownPins`, and `keys.pins(bbox)`/`keys.search(q)` do not include the company. So the previous company's pins (names, addresses, pin cards) stay on the map under the new company's top bar until the refetch lands. If that refetch fails, they stay indefinitely, next to the error banner. Cached search results for the same q show the old company's results for a moment. The person can see both companies, so this is wrong data on screen, not a cross-tenant leak.
  - Suggestion: In `useSwitchCompany.onSuccess`, use `queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== keys.me[0] })` (or `resetQueries`) instead of `invalidateQueries`, so nothing from the old company survives. Alternatively, have MapView clear `shownPins` when `useMe().data.company.id` changes.
- [minor] tasks [11, 12]: Layout numbers are coupled across the two tasks. T11's MapView.module.css puts the banner and satellite toggle at `top: 72px` and the pin card at `bottom: 96px`. Those values assume T12's top bar (about 57px) and dock (70px + 16px). T12's Shell.module.css separately hard-codes 65px and 94px for the floating window. T12 also wraps MapView in a second `position: fixed; inset: 0` layer, duplicating T11's own fixed `.root`.
  - Suggestion: Follow-up (natural in Task 17, which already owns `--shell-bottom-inset`): have Shell set `--shell-top-inset` and `--shell-bottom-inset` on `.shell`, and use them in MapView.module.css and in the window override instead of 72/96/65/94. Drop one of the two fixed `inset: 0` wrappers.
- [minor] tasks [10, 11, 12]: Test infrastructure is duplicated across the three branches. There are three fetch stubs: auth.test.tsx's own `stubApi`, T12's `helpers.tsx` `stubApi`, and T11's `json()` + `vi.fn` mocks. `USER`, `COMPANY`, `ACCOUNT`, `where` and `renderApp` are duplicated between auth.test.tsx, helpers.tsx and shell.test.tsx. Timeouts are set in three places: vitest.config.ts testTimeout 15 s (T12), setup.ts asyncUtilTimeout 4 s (T12), and auth.test.tsx's `vi.setConfig({ testTimeout: 30_000 })` + `configure({ asyncUtilTimeout: 10_000 })` (T10 fix).
  - Suggestion: After the merge (separate follow-up commit), move auth.test.tsx onto helpers.tsx (`stubApi` + `SHELL_ROUTES`, fixtures, `where`). Keep one timeout source, the vitest.config.ts / setup.ts pair, and delete the per-file override in auth.test.tsx, or raise the global values if 30 s / 10 s are really needed under load.
- [minor] tasks [11, 12]: The layering points the wrong way. `api/hooks.ts` (T11) imports `type { Bbox } from '../shell/map/types.ts'`, placed between `./client.ts` and `./keys.ts`, so the shared API layer depends on a feature folder. T12's `copy/dock.ts` and `copy/comingSoon.ts` import types from `shell/apps.ts`, which imports `dockIcons.tsx`. These are type-only imports, so nothing breaks today.
  - Suggestion: Move `Bbox` into `api/types.ts` and have `shell/map/types.ts` re-export it. Optionally move `AppKey`, `WindowKey` and `ComingSoonKey` into a tiny `shell/appKeys.ts` with no runtime imports, which both apps.ts and the copy files use.
- [minor] tasks [11, 12]: Style is inconsistent between the branches. `copy/map.ts` exports `mapCopy`, while every other copy module exports a bare noun (`auth`, `common`, `errors`, `shell`, `dock`, `search`, `storm`, `comingSoon`), and the brief calls it `copy.map`. T12's SearchDialog.tsx and UserMenu.tsx use single-quoted JSX attributes (17 occurrences), while T11, T10 and T12's own Shell, AppWindow and StormWindow use double quotes. T12's report says double quotes is the repo style. No lint rule enforces either.
  - Suggestion: Low priority. Either accept `mapCopy` (it avoids shadowing `Array.prototype.map` and `Map` names) or rename to `map` in a follow-up. Normalise SearchDialog and UserMenu to double quotes, and consider adding `jsx-quotes: ['error', 'prefer-double']` to the web ESLint config.
- [minor] tasks [11]: This affects Task 13 once T11 sits in T12's shell. MapView requests pins only after MapLibre's `load` event supplies a bbox, so the screen-reader summary depends on WebGL. When the map cannot start (headless Chromium on a GPU-less CI runner without SwiftShader), `createMap` returns null and the banner shows, but no pins are ever requested and no summary is rendered. Task 13's e2e test 'map home shows the seeded pins' (`getByText('Map showing 70 customers and 25 open jobs.')`) would then fail. Also, `normalizeBbox` clamps each edge separately, so a view panned wholly onto a world copy (both longitudes above 180) becomes w == e. T7's spec answers that with a 400, and the banner shows.
  - Suggestion: Tell Task 13 to launch Chromium with working WebGL (e.g. `--use-angle=swiftshader --enable-unsafe-swiftshader`). Optionally, when the map fails to start, have MapView fall back to requesting pins for `area.bounds` so the summary still renders. For the bbox edge, wrap longitudes (or skip the request when w >= e) before calling the API.
- [minor] tasks [11, 12]: Accessibility details for the T13/T17 scans. Several `role="status"` regions are always mounted on the map home: the ToastProvider region, T11's map banner region, and T12's search StatusLine while open. A bare `getByRole('status')` in later tests will match more than one. T11's live summary paragraph and banner sit outside the map's `role="region"` landmark, and the shell has no `<main>`. The axe best-practice 'region' rule may flag this if Task 17 enables best-practice tags.
  - Suggestion: Note for Tasks 13 and 17: find the banner and summary by text, not by bare role. If the a11y scan flags 'region', move the summary and banner inside the map region div, or wrap the map and outlet in `<main>` in Shell.tsx.
