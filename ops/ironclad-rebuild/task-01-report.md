# Task 01 — Ironclad shared design system and shell

Branch: `codex/ironclad-full-ui-01`. Base verified from origin: `81b9251490cfa05eac4baecc68f6952b549a1460`, containing complete launch source `ff772d5cbf87eac051759e9049fb29930845a45f`. Implementation commits: `2426db0ab5e6d133c52d4e14c1b0da5936ed1be1` (main redesign) and `ef55d423fd2356cdde41e7e20ee1c3e06d92bf68` (final phone Demo/setup touch-target safeguard); both pushed. This report is a subsequent documentation-only commit; its SHA is the branch head. No main/integration push or merge.

## Compatibility and geometry handoff

Existing public component APIs and all token names remain available. `Window` adds only optional `titleIcon: ReactNode`; existing callers continue unchanged. No export, route, dependency, lockfile, hook, feature business logic or backend changes. Map pin/stage/hail semantic colors are unchanged. `ReviewSteps` changes only corner styling; props, permission checks, pending/approval behavior and callbacks are untouched.

- Neutral surface `#f6f7f8`, secondary `#e9edf0`, graphite `#151c22`, opaque AA muted ink `#53616b`; yellow accent `#ffc400`. Primary buttons use graphite with white text. Danger fill is `#c9343d` for AA white text. Body/minimum remain 14px/12px.
- Shared card/window/control radii are 20px/18px/8px. New compatible tokens: `surface-raised`, `surface-glass`, `radius-control`, `shadow-card`, and six `app-*` colors. CSS/TypeScript mirrors are checked together.
- Desktop `--shell-base-top: 34px`; `--shell-top-inset` still adds measured banner height; windows start another 8px below that. `--shell-bottom-inset: 92px`; desktop windows use 20px side margins. No fixed 1280px cap.
- Phone topbar 44px; page window 8px side margins and 8px top clearance; navigation 56px tall, 12px side/bottom clearance plus safe-area bottom. Window bottom inset is 80px plus safe area. Five labeled phone destinations and the complete More sheet remain.
- Dock: 50px colored tiles, 10px gaps, 12px horizontal padding, 70px height, 22px radius, 12px bottom clearance. Names remain accessible and appear on hover/focus; badges retain their accessible count meanings. Six existing registry apps remain in their original order.
- Inputs use 16px on phone to prevent focus zoom. Buttons/icon controls retain at least 40px phone targets. Existing focus traps, Escape, opener focus restoration and nested dialogs remain.

## Evidence

Read and inspected committed `desktop-1440x900.jpg`, `front-desk-1440x900.jpg`, `desktop-phone-390x844.jpg`, `front-desk-phone-390x844.jpg`, both measured JSON files and reference README. No live-reference browsing is claimed.

Actual Chromium render of the built application with isolated empty API fixtures (not customer or production data):

| Measurement | Reference | Task 01 observed |
| --- | --- | --- |
| Desktop topbar | 34px; 13px type; glass .82 | 34px; 13px; glass .82 |
| Desktop window at 1440×900 | x20 y42, 1400×766; radius18 | x20 y42, 1400×766; radius18 |
| Desktop dock | y818, h70; radius22 | y818, h70; radius22 |
| Desktop dock width | 576px, nine controls | 374px, six existing apps; controller request below |
| Phone window at 390×844 | x8 y52, bottom764 | x8 y52, 374×712, bottom764 |
| Phone document width | 390px | 390px; also 360px at 360×800 |

Screenshots actually obtained and inspected (refreshed after the final source build): `/workspace/work/task-01/screenshots/task-01-jobs-1440x900.png`, `task-01-jobs-390x844.png`, `task-01-jobs-360x800.png`, `task-01-search-desktop.png`, `task-01-more-phone.png`. Measured evidence: `task-01-visual-metrics.json` beside those files. These are session scratch evidence, not committed reference assets. Blank map tiles are intentional in the isolated test build; feature interiors remain owned by their assigned tasks. Do not treat these images as complete product fidelity or live-provider evidence.

Before/after renders were captured from the verified preparation source (exported with `git archive` into session scratch; application checkout never reset) and the final built source using identical fixtures. The baseline screenshots and measured JSON are under `/workspace/work/task-01/baseline-screenshots/` with the same filenames as above. Inspected baseline desktop and phone images show the warm surfaces and edge-to-edge phone bar. Measured baseline desktop window: x80 y65, 1280×741, radius14; topbar57px. Final desktop: x20 y42, 1400×766, radius18; topbar34px. Baseline phone window: x0 y57, 390×739, radius0; final phone: x8 y52, 374×712, radius18. Baseline scoped unit suite passed before edits.

## Preserved behavior

Shell's banner ResizeObserver, company-keyed lazy map/error boundary, Today auto-open, unread/draft/attention counts and navigation wiring remain unchanged. Account/company switching, setup ring, Demo badge, recents/search actions and permission filtering keep their existing hooks. Billing/demo components remain mounted through their current interfaces. The API/backend/provider/database/worker/send-gate paths are unchanged. Nothing fabricates operational statistics or simulates a working mutation.

## Checks and infrastructure

Git fetch initially failed with a proxy connection error. Diagnosis showed runtime running, restricted policy enforced and GitHub allowed, but shell socket calls returned EPERM. Per-command `with_additional_permissions` network permission restored Git/Docker connectivity through the existing proxy; no network-policy, credential or proxy changes were made. The required origin ref and ancestry were verified before creating this branch. `npm ci` succeeded with cache under `/workspace/work/task-01/npm-cache`; the initial attempt could not write the default home cache. Node v24.19.0 satisfies the repository floor. `npm ls playwright-core` resolves only 1.56.1.

Commands and observed results (logs in `/workspace/work/task-01/`):

| Check | Result |
| --- | --- |
| `npm ci --cache /workspace/work/task-01/npm-cache` | Pass; dependency and lockfiles unchanged |
| `npm ls playwright-core` | Only 1.56.1 |
| Baseline focused UI/shell suites | 14 files, 225 tests passed before edits |
| Final `npx vitest run --project @roofline/ui --project @roofline/web packages/ui/test apps/web/test/{ironclad-full-01,shell,phone,top-bar,search-dialog,search-actions,company-switch,a1-dock}.test.tsx` | 16 files, 230 tests passed |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm run lint:css` | Pass |
| `npm run build:web` | Pass; existing large-bundle warning remains |
| `npx vitest run --project @roofline/web --project @roofline/ui --project @roofline/shared --project @roofline/send-gate` | 203 files: 202 passed, 1 failed; 3,486 tests passed, 1 failed (old documented hail palette ratios; see below) |
| `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c apps/web/playwright.config.ts --project=desktop shell.spec.ts a11y.spec.ts` | Docker/PostGIS/API/worker actually ran with fake providers. 34 passed, 2 failed in 7 minutes; details below |
| `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c apps/web/playwright.config.ts --project=phone phone.spec.ts -g 'bottom tabs work\|top bar at\|no horizontal scroll\|Approve stays pinned\|long text does not widen'` | Docker-backed; 6 passed in 53.5s |
| `npx playwright test --list -c apps/web/playwright.config.ts` | 109 tests in 20 files discovered; inventory only |
| `git diff --check` and ownership comparison | Pass; all 35 source/test files are exclusively allowed for key 01 |

New regressions cover neutral text/danger contrast, decorated-window accessible description/Escape/opener focus, dock names/counts/current destination, dynamic banner measurement/observer cleanup, and search-over-window Escape/focus behavior. The final focused suite includes unchanged company-switch/search/phone/ReviewSteps regressions. New UI tests were run against the old implementation and failed before implementation. A new web test initially selected multiple comboboxes; it was corrected to select by accessible name, without changing application behavior.

The broad unit failure is `apps/web/test/hail-contrast.test.ts:34`: the documented fill/background ratio array for the old beige background is `[1.1, 1.5, 2.1, 2.8, 3.9]`; the new neutral background gives `[1.1, 1.5, 2.2, 2.9, 4]`. Outline contrast and distinct hail colors still pass. This existing test is outside the allowlist; request controller update the measured snapshot/comment without weakening the outline assertion.

Desktop E2E failures:

- `shell.spec.ts:57`: old `width <= 1280`, received 1400, matching the new reference geometry. Existing test remains untouched for controller update.
- `a11y.spec.ts` public storm landing page: the company test hostname showed `Domain forbidden`, so the Name field could not load. This is a local restricted-network hostname limitation; no proxy bypass or egress widening was attempted. It is not an accessibility pass. GitHub CI must verify this route. Other 29 accessibility scans and five shell scenarios passed, including public homeowner, Front Desk, approvals and agent screens.

After the final CSS-only touch-target safeguard, CSS lint and web build passed again; the phone plus task-01 unit suites passed 9/9. Additional actual-browser layout checks at 360/390/768/1024/1440 included long names, a pending approval, Demo mode, incomplete setup and a canceled-company billing banner: no page overflow, banner-aware windows shifted to y185 on phone/y118 on desktop, and every phone topbar target measured at least 40px. These checks used isolated fixtures and are recorded in `screenshots/edge-layout.json`.

Full Docker API/database unit suites, v1, Python hail and separate demo walkthrough were not run locally; these remain GitHub CI/integration gates. No real-provider smoke or production mutations occurred.

## Actual GitHub CI

Latest source run: [CI / 38334140109](https://github.com/parsasalahshori/roofline/actions/runs/38334140109), head `ef55d423fd2356cdde41e7e20ee1c3e06d92bf68`. At final observation it was **pending**, with no conclusion; this is not a CI pass. The earlier redesign run [CI #982 / 38333802693](https://github.com/parsasalahshori/roofline/actions/runs/38333802693), head `2426db0ab5e6d133c52d4e14c1b0da5936ed1be1`, had entered **in_progress**. The branch concurrency rule can cancel the earlier run when the latest starts.

Latest run job list was empty while pending. The prior run's observed jobs were:

| Job | Prior-run observed status | Link |
| --- | --- | --- |
| Platform | cancelled | [job](https://github.com/parsasalahshori/roofline/actions/runs/38333802693/job/115089260311) |
| E2E | in progress | [job](https://github.com/parsasalahshori/roofline/actions/runs/38333802693/job/115089260249) |
| v1 | success | [job](https://github.com/parsasalahshori/roofline/actions/runs/38333802693/job/115089260034) |
| Demo DB arm64 | cancelled | [job](https://github.com/parsasalahshori/roofline/actions/runs/38333802693/job/115089260264) |
| Hail service | cancelled | [job](https://github.com/parsasalahshori/roofline/actions/runs/38333802693/job/115089260741) |

The five required areas remain Platform, E2E, v1, Demo DB arm64 and Hail service. No successful conclusion for the latest source is claimed. Status was read through the connected GitHub tool; local `gh run list` was forbidden at `api.github.com` by the unchanged restricted policy. No CI result is inferred from the successful push. Expect the two obsolete visual snapshot/geometry assertions above to need controller adaptation; this is not a green integration handoff. Documentation-only report pushes are skipped by CI.

## Changed files

- `apps/web/src/shell/AppWindow.tsx`
- `apps/web/src/shell/Shell.module.css`
- `apps/web/src/shell/dockIcons.tsx`
- `apps/web/src/shell/phone/BottomTabs.module.css`
- `apps/web/src/shell/phone/MoreSheet.module.css`
- `apps/web/src/shell/phone/MoreSheet.tsx`
- `apps/web/src/shell/topbar/AgentsWorking.module.css`
- `apps/web/src/shell/topbar/SearchDialog.module.css`
- `apps/web/src/shell/topbar/ShellTopBar.module.css`
- `apps/web/src/shell/topbar/UserMenu.module.css`
- `apps/web/src/shell/topbar/WeatherChip.module.css`
- `apps/web/test/ironclad-full-01.test.tsx`
- `packages/ui/src/base.css`
- `packages/ui/src/components/Avatar/Avatar.module.css`
- `packages/ui/src/components/Badge/Badge.module.css`
- `packages/ui/src/components/Banner/Banner.module.css`
- `packages/ui/src/components/Button/Button.module.css`
- `packages/ui/src/components/Card/Card.module.css`
- `packages/ui/src/components/Dock/Dock.module.css`
- `packages/ui/src/components/Dock/Dock.tsx`
- `packages/ui/src/components/Field/Field.module.css`
- `packages/ui/src/components/FilePicker/FilePicker.module.css`
- `packages/ui/src/components/IconButton/IconButton.module.css`
- `packages/ui/src/components/Pill/Pill.module.css`
- `packages/ui/src/components/ReviewSteps/ReviewSteps.module.css`
- `packages/ui/src/components/Sheet/Sheet.module.css`
- `packages/ui/src/components/StatCard/StatCard.module.css`
- `packages/ui/src/components/Toast/Toast.module.css`
- `packages/ui/src/components/TopBar/TopBar.module.css`
- `packages/ui/src/components/Window/Window.module.css`
- `packages/ui/src/components/Window/Window.tsx`
- `packages/ui/src/tokens.css`
- `packages/ui/src/tokens.ts`
- `packages/ui/test/ironclad-full-ui.test.tsx`
- `packages/ui/test/tokens.test.ts`
- `ops/ironclad-rebuild/task-01-report.md`

## Controller requests and remaining gaps

1. Bundle licensed Archivo Variable through controller-owned dependency/asset integration, then set the font token. This task keeps the existing system fallback rather than adding an unowned font asset or remote request. Exact typography remains a gap.
2. Decide how the reference launcher/claims/search dock controls map onto the controller-owned app registry and routes. This task preserves the six existing apps and all phone destinations, so total dock width is narrower than the reference and phone navigation remains labeled. No inert launcher or invented route was added.
3. Update the old `apps/web/e2e/shell.spec.ts` `width <= 1280` geometry assertion to the new 20px-inset frame (1400px at 1440). The test is outside task 01's write allowlist and has not been weakened or edited here.
4. A true minimize/restore window lifecycle is not present in the route-owned shell model. This task keeps the working Close/Escape behavior and does not add a misleading minimize control.
5. Task 02 owns home widgets/map controls; task 03 owns Front Desk interior selection/layout; all other feature interiors remain with their owners. Task 09 should verify compact Demo badge/setup presentation with its final components. Integration must compare complete screens after those tasks land.

No whole-product readiness, exact font parity, complete dock parity or live-provider readiness is asserted.
