# Task 02 — Home map and Today handoff

## Branch and source

- Task branch: `codex/ironclad-full-ui-02` only.
- Implementation commit: `1ff200375f4fd86bcb2e787747a2be2c0a084426` (pushed).
- Verified preparation baseline: `81b9251490cfa05eac4baecc68f6952b549a1460`, exactly the fetched `origin/codex/ironclad-full-rebuild` tip at bootstrap.
- Verified complete-app ancestor: `ff772d5cbf87eac051759e9049fb29930845a45f`.
- The initial `work` checkout at `46c6e1f` had no tracked/untracked changes. No reset, discard, merge, force-push, integration push or main push occurred.
- Initial restricted command could not reach the proxy. Retried successfully with the managed runtime's supported per-command network permission. Proxy/policy/Chrome configuration was not changed. `npm ci --cache /workspace/work/npm-cache` succeeded; the default cache location was unwritable. Dependencies and lockfiles are unchanged.

## Implemented scope

Today now uses compact near-white widgets with graphite text, a date-first 27px greeting, 13px section labels, 20px padding/radius, flat readable rows, and 12px gaps. Names and next steps wrap instead of being truncated. Existing proposal amounts retain their exact/Estimate distinction. Urgent Front Desk follow-ups have a distinct readable label. Approvals, appointments and signed-proposal failures have read-only retry controls; loading does not claim an empty day.

`Today` accepts an optional `layout="home"`. This lays out 372px left and 360px right columns around an open map on desktop and one scrolling column on phone. The keyboard-operable Explore map / Show my day control hides the widget content, preserving focus on the toggle and making the map accessible on a small screen. The default remains the existing Today window. This component is ready for controller routing integration; **the home variant is not mounted on `/` in this task branch**, because routing/Shell integration is exclusively owned elsewhere.

Map presentation now has a horizontal hail key above the dock, compact surface-backed controls clear of attribution, a centered selected-pin card, and neutral map error surfaces. The existing OSM source is desaturated through raster paint only. No geographic data, source URL, service-area bounds, layer helper, hail threshold, pin interaction, focus behavior, clustering or MapTiler selection logic changed. The blank style still has no sources or glyph network requests and still uses the shared background token.

No fictional revenue, goals, weather forecast, completed agent activity or business totals were added to emulate reference demo figures. This task uses the actual existing Today data contracts.

## Changed files (all key 02 allowlisted)

- `apps/web/src/copy/today.ts`
- `apps/web/src/features/today/Today.tsx`
- `apps/web/src/features/today/Today.module.css`
- `apps/web/src/shell/map/HailLegend.module.css`
- `apps/web/src/shell/map/MapErrorBoundary.module.css`
- `apps/web/src/shell/map/MapView.module.css`
- `apps/web/src/shell/map/PinCard.module.css`
- `apps/web/src/shell/map/mapStyle.ts`
- `apps/web/test/ironclad-full-02.test.tsx`
- This report.

No shared export, router, Shell, HTTP hook, feature type/helper, backend, provider, database, worker or send-gate file changed. Existing tests were not edited.

## Preserved workflows and boundaries

- The same approval queries, counted draft filtering, newest-first top three and See all link; no approval mutations or pending/version/409 semantics changed.
- The same company-zone greeting/date and calendar day link; real appointments, all-day labels, kind/customer/address, appointment deep links, follow-up job links and Front Desk urgent/message labels.
- Owner/office See everyone's day remains hidden for reps. No cross-role monetary summary was introduced.
- Signed proposals use the existing company-date query and signed option, with the existing exact versus Estimate price copy and proposal deep links.
- Today acknowledgment and once-per-day/deep-link behavior are unchanged; the new home component itself issues reads only.
- Map company remount isolation, last-good pins, real geographic bounds, server/client clusters, selection, `?focus=`, storm visibility/staleness, satellite eligibility, attribution and failure isolation remain on the existing implementations.
- Billing, demo/live separation, public signing/consent and all outbound/provider guards are untouched.

## Reference and actual visual evidence

Inspected the committed `reference/desktop-1440x900.jpg`, `reference/desktop-phone-390x844.jpg`, `reference/README.md` and `reference/desktop-metrics.json`. These are the exact supplied live Ironclad captures. No new live reference browser capture was made in this session.

Before: source had a single-column Today layout, nested bordered row cards, 24px/600 greeting, vertical lower-left hail legend and top-right map layer switches. No pre-change Roofline screenshot was captured; this before assessment comes from the verified baseline source, not an invented screenshot comparison.

After: browser-rendered component-preview measurements at 1440×900 show left cards at **x20/y50, width372**, right cards at **x1060/y50, width360**, each with **20px padding/radius**. The home preview has no horizontal overflow at 390×844 and no page errors. The preview uses explicitly synthetic test fixtures, the real component/hooks and the network-free map style; it is not a screenshot of the integrated home route or proof of live geographic tiles.

Screenshots actually captured and inspected:

- `home-desktop-1440x900.png`, `home-phone-390x844.png`: isolated home component preview, fixture data, no shared shell.
- `map-phone-390x844.png`: isolated preview after Explore map.
- `today-stack-desktop-1440x900.png`, `today-stack-phone-390x844.png`: real built app with seeded throwaway PostGIS + API + worker, existing Today route.
- `map-stack-desktop-1440x900.png`, `map-stack-phone-390x844.png`: real built app's map route and existing shell, blank network-free base map.
- `metrics.json`, `stack-checks.json`: captured geometry and overflow evidence. Stack checks found no document/dialog horizontal overflow at widths 375, 390, 768 and 1440.

Evidence is retained in `/workspace/work/task02/task-02-evidence.zip`; working originals are under `/workspace/work/task02/screenshots`. The designated projectless output directory could not be created: this cloud executor mounts `/codex` read-only, including when the supported filesystem permission was requested. Consequently the archive is retained in the cloud workspace, not attached as a downloadable session output. They are deliberately not committed into another owner's reference/QA directories. The screenshots show the baseline shell/font/background tokens. No claim of complete integrated Ironclad fidelity is made.

## Checks actually executed

| Check | Result |
| --- | --- |
| `npm ci --cache /workspace/work/npm-cache` | Passed; no dependency/lockfile changes |
| `npm ls playwright-core` | Only pinned `1.56.1` |
| Baseline nine scoped web suites | 50 passed |
| New regression before implementation | 3 failed / 4 passed, demonstrating missing behavior/style |
| Nine scoped suites plus `ironclad-full-02.test.tsx` | 57 passed in 10 files |
| `npx vitest run --project @roofline/web --project @roofline/ui` | 1,550 passed in 154 files |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run lint:css` | Passed, including final control-position adjustment |
| `npm run build:web` | Passed, including final CSS; existing large-chunk warning remains |
| `npx vitest run --project @roofline/api apps/api/test/map.test.ts apps/api/test/today.test.ts` | Real Docker/PostGIS execution: 44 passed in 2 files |
| `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run e2e -- today.spec.ts shell.spec.ts --project=desktop` | Real API/worker/PostGIS execution: 9 passed |
| `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run e2e -- phone.spec.ts --project=phone --grep 'bottom tabs work\|no horizontal scroll\|long text does not widen the page'` | Real stack: 3 passed |
| Axe WCAG 2 A/AA + 2.1 A/AA scoped to Today at 390px | Zero violations |
| Axe same tags scoped to home widgets at 390px | Zero violations |
| `git diff --check`, ownership audit | Passed |

Docker 28.4.0 was reachable through the same supported command permission. `postgis/postgis:16-3.4` was actually pulled and the test stacks ran. The installed Chromium executable was selected through the repository's supported `PW_CHROMIUM_EXECUTABLE` setting; no Chrome flags/configuration were changed. The first desktop invocation used the wrong positional ordering for Playwright's `--project` option and discovered no tests; the corrected command above executed all nine. Local E2E used installed Chromium with Playwright 1.56.1; GitHub CI uses its pinned browser installation.

The new tests cover real encoded navigation targets, company-zone day, no mutation/acknowledgment from the home component, keyboard hiding/reopening, rep visibility, honest pending/error states, signed-proposal retry, retained raster source/attribution/network-free fallback and both pin action kinds.

Full API/database/worker suites, the entire desktop/phone E2E inventory, the separate demo walkthrough, v1 and Hail were not rerun locally. They remain the GitHub/integration gates. No real-provider smoke, messages, spend or production changes occurred.

## GitHub CI (observed, not inferred)

Implementation run: https://github.com/parsasalahshori/roofline/actions/runs/38334429078 — commit `1ff200375f4fd86bcb2e787747a2be2c0a084426`.

At the latest handoff observation, the overall public page still says Queued; individual job states are:

- Platform: queued — https://github.com/parsasalahshori/roofline/actions/runs/38334429078/job/115091217038
- v1: queued — https://github.com/parsasalahshori/roofline/actions/runs/38334429078/job/115091217235
- E2E (includes separate demo walkthrough): running — https://github.com/parsasalahshori/roofline/actions/runs/38334429078/job/115091216923
- Demo DB (arm64): **passed** — https://github.com/parsasalahshori/roofline/actions/runs/38334429078/job/115091217005
- Hail: running — https://github.com/parsasalahshori/roofline/actions/runs/38334429078/job/115091217057

`gh run list` received Forbidden from `api.github.com`. The allowed public GitHub Actions page provided the actual run SHA, job URLs and status labels without changing or bypassing network policy. Pending jobs are not counted as passing. A later report-only commit does not trigger another CI run under the current paths-ignore rules.

## Controller integration requests and remaining gaps

1. **Router owner:** mount `<Today layout="home" />` on the map index only (not inside `AppWindow`, not behind other feature windows). Keep the current `/today` default layout, `useTodayAutoOpen` and acknowledgment contracts. Use a company-keyed mount so the Explore map display choice resets on company switch. Decide explicitly how the index should behave for `/?focus=...`; a focused property must stay reachable without a phone widget overlay covering its pin card. This task did not change routing or auto-open.
2. **Task 01 / shared shell owner:** retain the existing `--shell-top-inset` and `--shell-bottom-inset` CSS API, supplying new reference chrome geometry. Home positions use those variables (fallback desktop 34px top +16px; phone 44px +12px). Shared Archivo/local font packaging, neutral background token and shell/dock styling remain with that owner. The home preview's exact measured positions use the reference fallback geometry, while the actual branch's old shell still supplies its old insets.
3. **Controller visual integration:** compare final home/Today/map with all shared changes at 1440×900 and 390×844; verify banners, selected pin cards, expanded attribution, satellite+hail controls and keyboard traversal together. Check widget composition if adding real weather/activity/revenue cards through separately owned contracts. None of the reference's synthetic figures were imported.
4. **CI:** wait for all five real jobs, inspect failures if any, and repeat integration checks after combining task branches. A queued/running CI job and this isolated frontend implementation do not establish whole-product readiness.
