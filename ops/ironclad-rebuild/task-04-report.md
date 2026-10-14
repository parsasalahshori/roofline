# Task 04 — Estimator, measurements, quotes, proposals and homeowner signing

## Handoff

- Branch: `codex/ironclad-full-ui-04`.
- Implementation SHA: `4d8914693210bbe246a245d629314b0342fafbc0`. Pushed to origin; this report is a subsequent documentation-only commit on the same branch.
- Preparation verified exactly: `81b9251490cfa05eac4baecc68f6952b549a1460`; complete-app ancestor: `ff772d5cbf87eac051759e9049fb29930845a45f`.
- Started from clean tracked files at the old `46c6e1f` checkout, fetched the exact required source, and created the assigned branch. No existing work was reset or discarded.
- Task 04 implementation and scoped local verification are complete. Integrated visual fidelity and whole-product readiness are **not** claimed.

## Changes

The estimator now separates the real paginated proposal lists from a clear address workspace. A visible **Use this address** action supports touch users without requiring Enter. Searching, failed lookup, retry, selected home, customer information and review-before-send guidance are explicit. Address selection alone causes no measurement/proposal mutation and does not check text consent.

The measurement screen uses a compact 280px controls column beside the larger editable map on desktop, and a stacked map/controls layout on phones. Existing outline editing and labels remain. The UI exposes the existing save-pending state and explains report/proposal review.

Proposal options use a desktop comparison grid, clearer price hierarchy, and full-width name/material fields; phone editing uses one column. Quotes have grouped scope fields, clear lines/totals and compact phone summary cards. Unsaved feedback remains visible through refused saves and disappears only after accepted saves. Price, tier, financing and estimate settings retain every field and owner-only editing while adopting the neutral card system.

The public homeowner page compares options on desktop and stacks them on phones. Signing and decline bodies and the drawing pad have clearer visual grouping, while shared sheets retain their existing focus, consent, form and mutation behavior.

## Frozen behavior preserved

No changes to backend, database, providers, workers, send gates, HTTP hooks, wire types, price calculations, `OutlineEditor.ts`, `draft.ts`, handoff/format helpers, routing, shared exports, dependencies or lockfiles. An allowlist audit covered every changed/new tracked file.

Existing tests continue to exercise grouped status filtering/pagination, measurement-to-proposal ordering, retries without duplicate builds, drawing handoff, measurement autosave/flush and locking, exact-report role restrictions, option enablement/add-ons/pricing, quote snapshot prices/finalization/copy/downloads, proposal revise/send/link/PDF/status behavior, public cookie omission and token errors, consent/signing/decline/PDF readiness, and settings owner/read-only restrictions. New tests explicitly cover touch address selection without mutation or consent, failed lookup recovery, and unsaved feedback across a refused save.

## Reference and actual visual evidence

Read `reference/README.md`, `desktop-metrics.json` and `front-desk-metrics.json`; inspected committed `measure-1440x900.jpg` and `front-desk-phone-390x844.jpg`. The reference authority is https://roofing-os-demo.vercel.app/ . A fresh live fetch returned `CONNECT tunnel failed, response 403`; the restricted policy was preserved.

Reference facts used: graphite `#151c22`, near-white `#f6f7f8`, compact 13–14px body/labels, 16px window-level heading, 12px gaps, thin neutral outlines, rounded surfaces, yellow Measure identity, left list/control rail and a dominant roof workspace. The 280px feature rail is an implementation choice based on the Measure screenshot, not a claimed DOM measurement. Shared Archivo font and exact window/dock dimensions are task 01/controller responsibilities.

Before evidence is the verified baseline source plus 115 passing baseline tests: vertically stacked proposal groups/options, 55/45 measurement columns, warm inherited surfaces, a 640px homeowner column, and no visible address submit action. No baseline application screenshots were captured, so no pixel-diff claim is made.

After evidence: **22 actual Chromium screenshots** from the isolated PostGIS/API/worker stack using existing seeded synthetic data and `FAKE_PROVIDERS=1`, captured at desktop 1440×900 and phone 390×844 (full-page capture; tall public pages extend beyond the viewport). Files are under `/workspace/work/task04/evidence/`, with pairs named:

- `estimator-{desktop,phone}.png`
- `measurement-{desktop,phone}.png`
- `proposal-{desktop,phone}.png`
- `quote-{desktop,phone}.png`
- `prices-{desktop,phone}.png`
- `tiers-{desktop,phone}.png`
- `financing-{desktop,phone}.png`
- `estimate-settings-{desktop,phone}.png`
- `homeowner-{desktop,phone}.png`
- `signing-{desktop,phone}.png`
- `decline-{desktop,phone}.png`

`viewport-checks.json` records all 22 states: no document or dialog horizontal overflow. `sha256.txt` records screenshot hashes. Screenshots were inspected; narrow option fields and oversized phone quote stats were corrected and recaptured. The local scripts/logs are in `/workspace/work/task04/`. These are workspace evidence, **not committed artifacts**: the exclusive allowlist permits only the owned test/report and source. Controller/QA may collect them into its owned artifact area.

The test stack intentionally renders the existing blank map style without aerial credentials; the editable synthetic outline is visible. No satellite image was fabricated or overlaid. The screenshots still show the baseline shared shell; they do not prove the final integrated shell matches the reference.

## Checks actually run

Node `v24.19.0` satisfies the repo minimum. Initial Git access failed without command permission; supported `with_additional_permissions` network access recovered fetch/push and Docker. Proxy settings and policy were unchanged. Initial npm cache errors were resolved with `npm ci --cache /workspace/work/task04/npm-cache` (858 packages); no dependency changes. `npm ls playwright-core` resolved only **1.56.1**.

| Check | Actual result |
| --- | --- |
| Eight required existing web suites before editing | 115 passed |
| Eight existing suites plus the first two new regressions | 117 passed, 9 files |
| Final `ironclad-full-04.test.tsx`, including save-refusal regression | 3 passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run lint:css` | Passed, including final CSS |
| `npm run build:web` | Passed, including final source; existing large-chunk warning remains |
| Scoped Docker-backed API suites | 101 passed, 8 files |
| Existing estimator/homeowner Playwright specs with Docker | 3 passed; includes public keyboard-only signing at 375×812 |
| Real-stack visual checks | 22 captures; no document/dialog horizontal overflow |
| `git diff --check`, exclusive ownership/frozen-path audit | Passed |

Web command:

```sh
npx vitest run --project @roofline/web apps/web/test/estimator.test.tsx apps/web/test/measure.test.tsx apps/web/test/quote-editor.test.tsx apps/web/test/proposal-window.test.tsx apps/web/test/proposal-option-card.test.tsx apps/web/test/homeowner.test.tsx apps/web/test/settings-prices.test.tsx apps/web/test/settings-estimator.test.tsx apps/web/test/ironclad-full-04.test.tsx
```

API command (Docker reachable; isolated Testcontainers database):

```sh
npx vitest run --project @roofline/api apps/api/test/measurements.test.ts apps/api/test/quotes.test.ts apps/api/test/proposal-routes.test.ts apps/api/test/proposal-sign.test.ts apps/api/test/proposal-public.test.ts apps/api/test/read-only.test.ts apps/api/test/exact-report-routes.test.ts apps/api/test/tier-templates.test.ts
```

Browser command from `apps/web`, using the existing installed Chromium without changing Chrome:

```sh
PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test e2e/estimator.spec.ts e2e/homeowner.spec.ts --project=desktop
```

One initial Playwright command placed filenames after the variadic `--project` flag and only produced a CLI argument error; it ran no tests. The corrected command above completed all three tests. No real-provider smoke, real message, paid order, production operation or credential setup occurred.

## CI

Real push-triggered run for implementation SHA `4d8914693210bbe246a245d629314b0342fafbc0`:

https://github.com/parsasalahshori/roofline/actions/runs/38334514469

CI status at handoff: Demo DB (arm64) **passed**; Platform, E2E, Hail and v1 **queued**. All five jobs exist; no successful whole-CI result is claimed. The CLI GitHub API request was forbidden by the environment, so the run was located on GitHub's public Actions page and job status was read through the connected GitHub tool. A report-only push skips CI and is not a new verification result.

## Remaining gaps and cross-owner requests

1. **Task 01/controller:** integrate shared Archivo/local-font choice, exact 34px top bar, x20/y42 1400×766 window geometry, compact neutral shared controls, Sheet chrome and desktop/phone dock. Current task screenshots retain baseline outer shell sizing, 20px body inset and warm shared Sheet header/footer. Local feature palettes deliberately do not modify those shared files.
2. **Controller/QA:** repeat these screens after all branches are integrated, with representative permitted map imagery, and collect the workspace screenshot evidence into the QA-owned artifact path. Reference contains no exact proposal/quote/public-signing screenshots; those screens apply the measured common visual system while preserving all existing content.
3. **Controller:** consider route-specific window titles for measurement and quote deep links (currently inherited Estimator and Jobs); routing and shared copy remain untouched here.
4. **CI gate:** all five jobs and the separate demo walkthrough/full desktop+phone suite must finish successfully before integration. Only scoped suites and the fake stack checks above ran locally; v1, ARM64 demo DB, Python hail and the full product suite are not local claims.
5. **Owner-run live-provider validation:** still outside this redesign. No claims about real aerial reports, SMS delivery, storage or production readiness follow from fakes.

## Changed files

- `apps/web/src/copy/estimator.ts`
- `apps/web/src/copy/measure.ts`
- `apps/web/src/copy/quotes.ts`
- `apps/web/src/features/estimator/EstimatorWindow.module.css`
- `apps/web/src/features/estimator/EstimatorWindow.tsx`
- `apps/web/src/features/estimator/MakeProposal.module.css`
- `apps/web/src/features/estimator/MakeProposal.tsx`
- `apps/web/src/features/homeowner/DeclineSheet.module.css`
- `apps/web/src/features/homeowner/HomeownerPage.module.css`
- `apps/web/src/features/homeowner/SignFlow.module.css`
- `apps/web/src/features/homeowner/SignaturePad.module.css`
- `apps/web/src/features/measure/MeasureWindow.module.css`
- `apps/web/src/features/measure/MeasureWindow.tsx`
- `apps/web/src/features/proposals/OptionCard.module.css`
- `apps/web/src/features/proposals/ProposalWindow.module.css`
- `apps/web/src/features/quotes/QuoteEditor.module.css`
- `apps/web/src/features/quotes/QuoteLines.module.css`
- `apps/web/src/features/quotes/QuoteTotals.module.css`
- `apps/web/src/features/quotes/QuoteWindow.module.css`
- `apps/web/src/features/quotes/QuoteWindow.tsx`
- `apps/web/src/features/settings/FinanceEstimate.module.css`
- `apps/web/src/features/settings/PricesTab.module.css`
- `apps/web/src/features/settings/PricesTab.tsx`
- `apps/web/src/features/settings/TiersSection.module.css`
- `apps/web/test/ironclad-full-04.test.tsx`
- `ops/ironclad-rebuild/task-04-report.md` (this report).
