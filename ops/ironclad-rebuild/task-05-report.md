# Task 05 — CRM jobs, customers, creation and timeline

## Handoff

- Branch: `codex/ironclad-full-ui-05` only.
- Implementation SHA: `e35690de62883e16e7b1b3da96805d1afd05e55b`.
- Preparation verified exactly: `81b9251490cfa05eac4baecc68f6952b549a1460`; complete-app base `ff772d5cbf87eac051759e9049fb29930845a45f` verified as its ancestor.
- The initial `work` checkout was clean at `46c6e1f6`. The first ordinary fetch was blocked by connection refusal at the proxy. On authorized resume, `with_additional_permissions.network.enabled=true` allowed normal Git fetch/push, npm installation and Docker. Proxy settings and network policy were not changed.
- No additional agents/sessions, integration merge, main/integration push, force-push, dependency/config/lockfile edit, provider action, real message or production operation.
- Implementation is scoped to ownership key `05`. This report does **not** establish integrated visual fidelity or whole-product readiness.

## Changes

The pipeline now uses compact white cards, cool gray columns, quieter borders, smaller readable typography and blue selected controls. Customer and value share a row, followed by address and compact assignment/age metadata. Real next steps and stuck indicators remain visible. Existing five pipeline stages and Lost drawer are preserved; the seven reference stages and demo figures were not fabricated.

A visible desktop Board view / List view switch retains every URL filter and performs no mutation. Phone retains the stacked job list and native Move-to control. Search, source, assignee, archived filters, CSV export and New job remain available. Labels remain accessible when visually hidden in the compact desktop toolbar.

Customer records, job sections, create/edit forms and timeline use consistent neutral panels. Job stats are a compact semantic definition list with the existing monetary permission condition. Jobs have a Back to jobs link; appointment rows open the existing appointment-detail route. Customer tag/texting filters explicitly say they apply to the current page, and paging remains reachable when those filters have zero matches on that page.

## Preserved contracts and workflows

- All `api.ts`, HTTP client/hooks, response types, business helpers, backend/database/worker/provider/send-gate code and shared exports/router remain byte-for-byte unchanged from preparation.
- Board drag/move, paging, optimistic mutation handling, Lost reason, Won value and Installed-from-Won rules unchanged.
- Customer/job creation, existing-customer/home selection, new addresses, partial-create retry protection, field errors, assignment, edits, archive/restore and next steps unchanged.
- Rep scope and hidden job values/totals, export role visibility, consent/do-not-contact controls and billing refusal behavior retained.
- Existing quote creation, saved/final quote links, proposal creation with job context, proposal copy links, calendar links, approval/task links, ClaimSection and Front Desk timeline links retained. Standalone quotes/proposals belong to Task 04 and were not edited.
- Note validation, actual note mutation, timeline pagination, message status and Front Desk activity fallback unchanged. No cosmetic success simulations.
- Public signing, demo/live separation and approval conflict/pending behavior remain in their unchanged owning code; no claim of live-provider validation.

## Reference and visual evidence

Inspected committed `reference/pipeline-1440x900.jpg` and `reference/front-desk-phone-390x844.jpg`, `reference/README.md`, and the desktop computed-style measurements. The pipeline image is the direct CRM visual reference. No committed reference capture exists for customer details, creation forms or timeline; those use the documented visual system rather than invented screen-specific measurements.

Before, source used fixed 280px columns with 12px gaps, 4px colored heading borders, 16px customer-name text, vertically separated card metadata and a single-column job-detail stack. After, five flexible columns have a 190px minimum, 8px gaps, 13px card names/column headings, white 13px-radius cards and cool gray rails; detail sections use a responsive two-column layout and a full-width timeline. Existing data and meaningful controls determine remaining height.

Real browser captures use the repository's throwaway PostGIS/API/worker stack, built web app, seeded synthetic Acme Roofing data, fake providers, Chromium and device scale factor 1. They are **not** screenshots of production or proof of real-provider readiness. Captures at 1440×900 and 390×844 are in the session workspace:

`/workspace/work/task05/evidence/`

- `pipeline-desktop.png`, `pipeline-phone.png`
- `customers-desktop.png`, `customers-phone.png`
- `job-desktop.png`, `job-phone.png`
- `customer-desktop.png`, `customer-phone.png`
- `new-job-desktop.png`, `new-job-phone.png`
- `new-customer-desktop.png`, `new-customer-phone.png`
- `timeline-desktop.png`, `timeline-phone.png`
- `edit-job-desktop.png`, `edit-job-phone.png`
- `edit-customer-desktop.png`, `edit-customer-phone.png`
- `add-home-desktop.png`, `add-home-phone.png`
- `move-lost-desktop.png`, `move-lost-phone.png`
- `jobs-list-desktop.png`
- `manifest.json`: source SHA and SHA-256 hashes of all 23 captures.
- `layout-checks.json`: all six primary screens at both sizes had no visible horizontal overflow; dialog clientWidth matched scrollWidth.

All 23 captures were visually inspected. The current shared desktop window is 1280px wide (1278px inner) and the shared chrome still has the baseline warm palette; the reference window is 1400px wide at x20/y42. These are cross-owner integration gaps. No before-rebuild browser capture was taken; the before comparison above is source inspection, not a claimed screenshot comparison. Scratch capture script and logs are under `/workspace/work/task05/`, outside the exclusive source allowlist. Images were not added to the repository because key 05 does not authorize image/artifact paths.

## Verification

| Check | Actual result |
| --- | --- |
| `npm ci --cache /workspace/work/task05/npm-cache` | Pass; 858 packages installed. Initial default-cache attempt failed because `/home/agent/.npm/_cacache` was not writable/available; retry used workspace cache. Lockfile unchanged. |
| `npm ls playwright-core` | Only pinned `1.56.1`. Runtime Node `v24.19.0` satisfies `>=22.13`. |
| Baseline ten brief-listed web suites | 10 files / 98 tests passed before implementation. |
| Same suites plus `ironclad-full-05.test.tsx` | 11 files / 101 tests passed after implementation. |
| New regression red phase | Missing desktop switch and missing pagination both failed before implementation; phone list test passed. |
| New regressions | Board/list preserves all filters and rep hidden money/export; phone retains reachable Move-to; no-match page-local filter still permits next/previous paging. |
| `npm run typecheck` | Pass after correcting test-only unsupported Testing Library options. |
| `npm run lint` | Pass. |
| `npm run lint:css` | Pass. |
| `npm run build:web` | Pass; existing large-chunk warning remains. |
| Scoped API suite, real Testcontainers PostGIS | 8 files / 310 tests passed: jobs-board, jobs, jobs-stage-rules, quotes, customers, timeline, read-only, read-only-guard. |
| Desktop `crm.spec.ts` | All 6 passed on local full stack: board, drag/Lost reason, create job, timeline, quote final/PDF, rep isolation. Final implementation SHA repeated these plus C1 phone: **7/7 passed** (47.4s). |
| Entire local phone project | 15 passed, 2 failed at public storm company-host URLs displaying `Domain forbidden`. C1 CRM phone overflow test passed. See precise failures below. |
| Full web/UI suites | 154 files / 1,546 tests passed. |
| Scope audit and `git diff --check` | Pass: only key 05 allowlisted source/test plus own report. |

Commands and full logs are under `/workspace/work/task05/`. Relevant commands:

```sh
npx vitest run --project @roofline/web apps/web/test/ironclad-full-05.test.tsx apps/web/test/jobs-board.test.tsx apps/web/test/job-window.test.tsx apps/web/test/customers-list.test.tsx apps/web/test/customer-window.test.tsx apps/web/test/customer-edit.test.tsx apps/web/test/create-job.test.tsx apps/web/test/create-customer.test.tsx apps/web/test/timeline.test.tsx apps/web/test/d1-t26-timeline.test.tsx apps/web/test/e1-job-proposals.test.tsx
npx vitest run --project @roofline/api apps/api/test/jobs-board.test.ts apps/api/test/jobs.test.ts apps/api/test/jobs-stage-rules.test.ts apps/api/test/quotes.test.ts apps/api/test/customers.test.ts apps/api/test/timeline.test.ts apps/api/test/read-only.test.ts apps/api/test/read-only-guard.test.ts
PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c apps/web/playwright.config.ts crm.spec.ts --project=desktop
PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c apps/web/playwright.config.ts --project=phone
npx vitest run --project @roofline/web --project @roofline/ui
PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c apps/web/playwright.config.ts crm.spec.ts phone.spec.ts --project=desktop --project=phone --grep 'the board shows|drag a lead|a new job from|the timeline shows|a quote prices|a rep sees|C1 pages'
```

Docker/network-dependent commands used the supported per-command network permission. The initial E2E invocation with `--project desktop crm.spec.ts` was rejected by Playwright's variadic project parser before tests started; corrected to `crm.spec.ts --project=desktop` above.

Local phone failures:

1. `doors.spec.ts` — “landing page on a phone submits a request”.
2. `phone.spec.ts` — “S1 pages do not scroll sideways”.

Both reached `companyHostUrl('/storm/' + code)` and could not find Request a free inspection. Both error-context snapshots contain only `Domain forbidden`. The tests, company-host resolver configuration and network policy were left unchanged. Traces are in `apps/web/test-results/`. These are unresolved local environment failures, not counted as passes. Real GitHub E2E remains required.

## GitHub CI

Implementation run: https://github.com/parsasalahshori/roofline/actions/runs/38334367522 (push event, exact SHA `e35690de62883e16e7b1b3da96805d1afd05e55b`). The shell `gh run list` was denied at `api.github.com`; the installed GitHub connector successfully read the actual run and all five jobs. No restriction was bypassed.

Last observed October 12, 2026 at 7:02 PM America/Los_Angeles:

| Required CI area | Actual status |
| --- | --- |
| v1 (node:test) | Completed, success |
| Platform (lint, typecheck, tests) | Queued |
| E2E (Playwright) | Queued |
| Demo DB (arm64) | Queued |
| Hail service (ruff, pytest) | Queued |

CI is **not yet green**; four jobs await runners. Controller must check this exact run before integration. A report-only follow-up commit does not start CI (`ops/**` is ignored); the implementation run is the relevant evidence.

## Integration requests and remaining gaps

1. **Task 01/controller:** supply shared Archivo-compatible typography, neutral window background, 1400×766 desktop geometry at 1440×900, titlebar/dock/phone shell. This branch intentionally does not edit shared tokens, shell, router or exports. Repeat matching-viewport screenshots after integration.
2. **Task 07:** retain ClaimSection's interface and apply its owned visual treatment. It remains mounted, with its existing real data and actions.
3. **Task 04/controller:** standalone quote/editor/public proposal UI is outside key 05. The CRM links and mutation contracts remain compatible; quote finalization/PDF passed the real local stack test.
4. Customer tag/texting filters remain page-local because the frozen endpoint has no corresponding server filtering. The UI now discloses that scope and avoids trapping navigation on an empty filtered page.
5. The reference's seven business stages, synthetic signed-this-month metrics and AI/hail badges have no identical fields in the current CRM card contract. They were not invented or substituted for actual backend stages/data.
6. Full GitHub CI, integrated screenshots and the separate demo walkthrough remain controller gates as recorded by their actual run status. No live-provider manual smoke was run.

## Changed files

- `apps/web/src/copy/customers.ts`
- `apps/web/src/copy/jobs.ts`
- `apps/web/src/features/create/Create.module.css`
- `apps/web/src/features/create/NewCustomer.module.css`
- `apps/web/src/features/create/NewJob.module.css`
- `apps/web/src/features/customers/CustomerWindow.module.css`
- `apps/web/src/features/customers/CustomersWindow.module.css`
- `apps/web/src/features/customers/CustomersWindow.tsx`
- `apps/web/src/features/customers/EditCustomerSheet.module.css`
- `apps/web/src/features/job/EditJobSheet.module.css`
- `apps/web/src/features/job/JobHeader.module.css`
- `apps/web/src/features/job/JobHeader.tsx`
- `apps/web/src/features/job/JobSections.module.css`
- `apps/web/src/features/job/JobSections.tsx`
- `apps/web/src/features/job/JobWindow.module.css`
- `apps/web/src/features/job/JobWindow.tsx`
- `apps/web/src/features/job/StageStepper.module.css`
- `apps/web/src/features/jobs/Board.module.css`
- `apps/web/src/features/jobs/BoardColumn.module.css`
- `apps/web/src/features/jobs/BoardFilters.module.css`
- `apps/web/src/features/jobs/BoardFilters.tsx`
- `apps/web/src/features/jobs/JobCardView.module.css`
- `apps/web/src/features/jobs/JobCardView.tsx`
- `apps/web/src/features/jobs/JobsList.module.css`
- `apps/web/src/features/jobs/JobsTabs.module.css`
- `apps/web/src/features/jobs/JobsWindow.tsx`
- `apps/web/src/features/jobs/MoveJobMenu.module.css`
- `apps/web/src/features/jobs/MoveJobSheet.module.css`
- `apps/web/src/features/timeline/FrontDeskCard.module.css`
- `apps/web/src/features/timeline/NoteComposer.module.css`
- `apps/web/src/features/timeline/Timeline.module.css`
- `apps/web/test/ironclad-full-05.test.tsx`
- `ops/ironclad-rebuild/task-05-report.md`
