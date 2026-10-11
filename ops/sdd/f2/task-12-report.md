# Task 12 report: Web shell (top bar, dock, windows, search, user menu)

Status: DONE
Worktree: `/Users/parsasalahshori-a/RooflineWork/wt/t12`, branch `f2-t12` (base 2759c9e)
Commit: `c948f3f feat(web): shell with top bar, dock, windows, search and user menu` (42 files, +2272 / -16)

## What was built, by package

**Package A (shell chrome)**
- `shell/Shell.tsx` + `Shell.module.css`: the one layout under the session route. Map behind, top bar fixed above it, Dock fixed bottom center (z-index 30; Window stays at 20; `--shell-bottom-inset` left to Task 17).
- `shell/AppWindow.tsx`, `NotFoundWindow.tsx`, `apps.ts`, `dockIcons.tsx`, `useIsPhone.ts`, `countedDrafts.ts`. Dock badge counts are a `Record<AppKey, number>`; a badge shows only when the count is above 0 (front-desk, jobs and calendar are fixed at 0).
- `features/coming-soon/ComingSoon.tsx`, `features/storm/StormWindow.tsx` (+ css).
- `shell/map/MapView.tsx`: stub per Ruling L (`export function MapView(props: { onOpen(target) })` renders `<div data-map-stub />`). Task 11's real file wins at merge. `copy/map.ts` is not created (Task 11 owns it).
- `app/router.tsx`: session route now has the Shell as its single child layout. Routes: index (map, no window), `approvals`, `approvals/:taskId`, `storm`, `storm/plans/:taskId`, `storm/*`, `front-desk/*`, `estimator/*`, `jobs/*`, `calendar/*`, `agents/*`, `customers/*`, and `*` (NotFoundWindow). Ruling B placeholders (`approvals`, `approvals/:taskId`, `storm/plans/:taskId`) go through a small `comingSoonWindow(app)` helper; Task 14 replaces them.
- Copy: `copy/comingSoon.ts`, `dock.ts`, `shell.ts`, `storm.ts`.
- Tests: `test/shell.test.tsx` (6 tests; the brief's seventh, weather hidden, lives in Package B's tests per the lead's ruling), `test/auth.test.tsx` adjusted (MapView `vi.mock`, SHELL_ROUTES merged into `stubApi`, five heading assertions moved to the dock navigation).

**Package B (top bar)**
- `shell/topbar/ShellTopBar.tsx` (company name + logo mark, OkPill and AgentsWorking in the middle, WeatherChip, SearchDialog and UserMenu at the end), `OkPill.tsx`, `AgentsWorking.tsx` (+ css), `WeatherChip.tsx` (+ css), `topbarIcons.tsx`.
- OkPill counts tasks from the approvals list (one counted draft plus one expired proves it is not the server `count`). WeatherChip is hidden when the weather is null or the query errors (a failed refetch after a success also hides it, taken literally from the brief).
- Hooks added to `api/hooks.ts`: `useApprovals`, `useTasksSummary`, `useAttentionCount`, `useWeather`, `useSearch` (disabled under 2 characters).
- Tests: `test/ok-pill.test.tsx`, `test/top-bar.test.tsx` (includes weather hidden on null and on error).

**Package C (search and user menu)**
- `shell/topbar/SearchDialog.tsx` (+ css), `searchOptions.ts`, `searchIcon.tsx`, `copy/search.ts`. Owns its icon-button trigger, the window-level Ctrl/Cmd+K listener, a portaled panel with combobox, 200 ms debounce, state chain, grouped listbox and arrow/Enter keys.
- `shell/topbar/UserMenu.tsx` (+ css): desktop popover and phone Sheet sharing one `MenuList` (switch company, sign out).
- Tests: `test/search-dialog.test.tsx` (10), `test/user-menu.test.tsx` (8).

**Shared**
- `apps/web/vitest.config.ts` (testTimeout and hookTimeout 15 s) and `apps/web/test/setup.ts` (RTL `asyncUtilTimeout` 4 s): the shell tests mount the whole app and exceeded the 5 s / 1 s defaults when other worktrees load the machine.
- `apps/web/test/helpers.tsx`: shared `stubApi` / `renderApp` helper with `SHELL_ROUTES`.

## Review rounds

The finding texts were not part of the inputs given to the finalizing agent, so only the outcomes handed over are recorded.

- Round 1: verify passed, 3 findings. Opus contact check: F1 amended, F2 approved, F3 approved. Fixes applied as part of the working tree being finalized.
- Round 2: verify passed, 1 finding. Contact check: F4 amended. Fix applied.
- Round 3: verify passed, 0 findings. Clean; no further fixes.
- Rejected: none.

## Minors / judgment calls carried forward

- JSX attributes use double quotes (the repo's existing style), not the single quotes in the brief's snippets.
- `renderApp` also returns `queryClient` so the "no plan" test waits for the approvals query to settle instead of sleeping.
- Search input focus ring uses `outline-offset: -2px` (not the kit's 2px outside) because the dialog clips with `overflow: hidden`; departs from the global focus-ring constraint. Change if the lead wants the exact value.
- Mousedown-outside closing in UserMenu is desktop-only; the phone Sheet is portaled outside the root.
- Sign out relies on the route change to `/sign-in` to unmount UserMenu; the user-menu test answers `GET /api/auth/me` with 401 first because the test router keeps it mounted.
- WeatherChip also hides after a failed refetch following a successful load.
- Task 14 must swap the `approvals`, `approvals/:taskId` and `storm/plans/:taskId` placeholders in `router.tsx`. Task 17 sets `--shell-bottom-inset` on phone.
- Merge: Task 11's `shell/map/MapView.tsx` replaces the stub; `api/hooks.ts` (and `keys.ts`) are append-conflict candidates with Task 11.
- Commit trailer is `Co-Authored-By: Claude Sonnet 5.5` (the session's attribution rule) rather than the Opus 5.5 line named in the task text.

## Verify output (from the worktree root, after the final changes)

```
npx vitest run --project @roofline/web
 Test Files  11 passed (11)
      Tests  127 passed (127)
   Duration  23.10s
npm run lint        -> exit 0 (eslint . , no output)
npm run lint:css    -> exit 0 (stylelint, no output)
npm run typecheck   -> exit 0 (tsc -b)
npm run build:web   -> exit 0
  dist/index.html                   0.39 kB | gzip: 0.26 kB
  dist/assets/index-D5lbpwZQ.css   15.59 kB | gzip: 3.70 kB
  dist/assets/index-CWf7ips-.js   389.55 kB | gzip: 121.54 kB
  built in 1.28s
```
No changes were needed to make verify pass.
