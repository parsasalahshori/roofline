# Task 09 — account, setup, billing, imports and company settings

Branch: `codex/ironclad-full-ui-09`.
Preparation: `81b9251490cfa05eac4baecc68f6952b549a1460`; verified ancestry from complete-app base `ff772d5cbf87eac051759e9049fb29930845a45f`.
Implementation SHA: `7da7855ef3950ed0cfb0f2ef26449a0b77b6e677` (pushed). The subsequent report-only commit records this immutable implementation SHA and does not change tested code.

## Result and boundaries

Implemented the task 09 frontend scope using GPT-6 Astra, without delegation. No routing, shared exports, dependency/lockfile, HTTP hook, type, provider, database, worker, send-gate or business-helper changes. All changed files pass the exact ownership key 09 check. Other owners' imported settings interfaces remain intact. No main/integration push or merge.

- Auth screens use a cool neutral, rounded card, Roofline identity, dark primary action and phone-sized fields. Shared AuthLayout applies to sign-in, reset, invite and verification. Signup shows its two steps and permits password-based users to return to their details without losing company input. Google credential flow, safe redirects, field errors, pending states and trial disclosure remain intact.
- Settings keeps all eleven existing route links and role filtering. Compact segmented navigation brings the current section into view on phones. Company, team, billing, setup and connections have short context headings. Company editing and separate hourly-rate mutations remain unchanged.
- Team tables retain owner-only roles, spend permissions, storm alerts, activation and invitation actions. At phone width each row becomes a labelled vertical record, retaining table semantics and existing controls instead of requiring a wide table.
- Billing uses real plan/usage data, a visible loading state and an actionable read-error retry. All plan choices lock during a pending checkout/change request. Canceled-company checkout, owner-only reads, payment portal, checkout return invalidations and shell restriction banners remain intact. The trial usage-cost note is explicit; absent usage shows a truthful empty state.
- Setup shows server-derived progress, two columns on desktop and one on phone. All step mutations, skippable rules, carrier waiting/rejection states, payment requirements and forwarding/calendar links remain unchanged.
- Imports show five screen steps, preserve upload/mapping/preview/explicit unchecked consent/progress/retry/download, and reset local step state when a different import ID opens. The preview's horizontal table region is keyboard focusable. A step marker does not claim that a background import has finished.
- Texting registration gets a clear heading and a contained responsive form. Payment/email gates, hosted policy choice, rejected fields, submission payload and carrier status remain unchanged. Demo controls retain the server mode gate and real simulation hook; results now use status/alert announcements. Error/loading surfaces use the cool neutral palette.

## Reference and visual evidence

Read `reference/README.md`, `desktop-metrics.json` and `front-desk-metrics.json`; inspected the committed desktop and phone Front Desk JPEGs at 1440×900 and 390×844. Applied the measured graphite `#151c22`, cool gray `#f6f7f8`, 13–14px supporting text, compact 16px section headings, rounded white surfaces, subdued outlines and dark actions. Auth cards have a 20px radius. Phone fields remain 16px to avoid input zoom, with touch-sized controls.

Before: preparation source had warm inherited auth/settings surfaces, a narrow plain auth card, ungrouped company form, a 640px-minimum team table on phone, no import step indicator, no signup back action, an invisible billing loading state, and plan buttons that left other choices enabled during a request. After: the changes above are implemented and exercised; existing workflow tests were retained unchanged.

The reference directory has no auth/account/settings screenshots. Exact screen-for-screen fidelity for those pages is therefore not claimed. The baseline shared shell still has its old warm chrome, system font and window geometry; task 01/controller owns those files. This branch deliberately does not duplicate the shared shell rebuild. Local neutral variables are scoped to AuthLayout and Settings and preserve the existing UI token names.

Screenshots actually captured with Chromium from the running frontend, using explicit synthetic HTTP test fixtures, in `/workspace/work/task09/evidence/`: `signin`, `signup`, `reset`, `invite`, `company`, `team`, `setup`, `billing`, `import`, `texting`, `connections`, each with `-desktop.png` (1440×900) and `-phone.png` (390×844). These are presentation evidence, not live data or backend evidence. `visual-checks.json` records viewport overflow, uncaught page errors and scoped axe results. Artifacts stay outside the repository because key 09 grants no screenshot directory. No before-implementation browser capture was taken; the before comparison is source-based. Reference images are unmodified.

## Verification

All commands use the lockfile and existing fake provider seams. Networked Git/npm/Docker/browser commands use the cloud runtime's per-command network permission; no proxy or network-policy changes. Initial npm cache failure was recovered with `npm ci --cache /workspace/work/task09/npm-cache`. Node is v24.19.0; Docker is 28.4.0; installed `playwright-core` resolves only 1.56.1. Browser execution uses the configured supported `PW_CHROMIUM_EXECUTABLE=/usr/bin/chromium` override.

| Check | Actual result |
| --- | --- |
| Baseline task-brief web suites | 10 files, 115 tests passed |
| New regression test before changes | Four cases failed as expected |
| Final scoped web suites | 14 files, 150 tests passed; includes all ten brief suites, hourly-rate, safe-next, F3 routes, and five new cases |
| `npm run typecheck` | Passed after correcting the new test's period-start fixture |
| `npm run lint` | Passed after moving the signup UI flag out of a render-time ref read |
| `npm run lint:css` | Passed |
| `npm run build:web` | Passed; existing large-bundle warning remains |
| Scoped API suites with PostGIS | 6 files, 228 tests passed: billing-routes, imports-api, team, signup-company, setup, texting-submit |
| Scoped desktop E2E | 7 passed: signup, billing (2), import, setup (3); real local API/worker/PostGIS with fake providers |
| Separate demo walkthrough | 1 passed, isolated `playwright.demo.config.ts` stack and database |
| Desktop/phone visual and axe checks | 22 screen/viewport pairs; no page overflow, uncaught page errors or scoped WCAG 2 A/AA and 2.1 AA violations |
| `git diff --check` and key 09 allowlist | Passed |

Final desktop + phone E2E rerun: **21 passed, 1 infrastructure-blocked failure**. The last `phone.spec.ts` S1 overflow test reached its public storm form navigation but received a page containing only `Domain forbidden` at the test-company hostname, so `Request a free inspection` was absent. This is not a passing public-form check. No source or network-policy change was made to suppress it. The task-specific desktop cases all passed again. CI state is recorded below. Commands/logs are in `/workspace/work/task09/`. Scope checks are not full-product readiness or live-provider proof. No live sends, billing purchase, carrier registration or real provider smoke was performed.

Own regression file: `apps/web/test/ironclad-full-09.test.tsx`. It covers signup back navigation preserving both steps without submitting; failed billing read/retry; checkout and plan-change pending locks and exact payloads/error recovery; and switching import IDs without retaining the previous import's preview step or starting an import.

## Integration requests and gaps

1. Task 01/controller: integrate shared Ironclad font, tokens, window geometry and shell chrome, then repeat these captures. Keep shared component APIs and 40px+ phone targets. The local palette uses the existing token names and can be reconciled with the final shared palette by the controller.
2. Controller: obtain reference captures for auth/settings if exact page-level matching is required; none were supplied for this scope. Map imagery is outside this task's evidence; visual fixtures use empty map data and do not establish map fidelity.
3. Controller: preserve and verify shared company-switch query clearing/remount behavior, routing and error recovery in the assembled product. This branch makes no shared changes.
4. GitHub CLI CI reads return `Forbidden` for `api.github.com` under the restricted policy. The permitted public GitHub HTML pages exposed the actual run and queued state. Controller must confirm all five jobs complete successfully before integration; no CI success is claimed here.

## Changed files

- `apps/web/src/app/RequireSession.module.css`
- `apps/web/src/app/RouteError.module.css`
- `apps/web/src/copy/auth.ts`
- `apps/web/src/copy/billing.ts`
- `apps/web/src/copy/import.ts`
- `apps/web/src/copy/settings.ts`
- `apps/web/src/copy/setup.ts`
- `apps/web/src/copy/texting.ts`
- `apps/web/src/features/auth/Auth.module.css`
- `apps/web/src/features/auth/AuthLayout.tsx`
- `apps/web/src/features/billing/BillingTab.module.css`
- `apps/web/src/features/billing/BillingTab.tsx`
- `apps/web/src/features/billing/PlanPicker.module.css`
- `apps/web/src/features/billing/PlanPicker.tsx`
- `apps/web/src/features/billing/UsageMeters.module.css`
- `apps/web/src/features/billing/UsageMeters.tsx`
- `apps/web/src/features/demo/DemoBadge.module.css`
- `apps/web/src/features/demo/DemoBadge.tsx`
- `apps/web/src/features/imports/ImportWizard.module.css`
- `apps/web/src/features/imports/ImportWizard.tsx`
- `apps/web/src/features/imports/PreviewStep.tsx`
- `apps/web/src/features/imports/UploadStep.tsx`
- `apps/web/src/features/settings/CompanyTab.module.css`
- `apps/web/src/features/settings/ConnectionsTab.tsx`
- `apps/web/src/features/settings/Settings.module.css`
- `apps/web/src/features/settings/Settings.tsx`
- `apps/web/src/features/settings/TeamTab.module.css`
- `apps/web/src/features/settings/TeamTab.tsx`
- `apps/web/src/features/setup/SetupRow.module.css`
- `apps/web/src/features/setup/SetupTab.module.css`
- `apps/web/src/features/setup/SetupTab.tsx`
- `apps/web/src/features/signup/SignUp.tsx`
- `apps/web/src/features/texting/TextingForm.module.css`
- `apps/web/src/features/texting/TextingSetup.tsx`
- `apps/web/src/features/texting/TextingStatus.module.css`
- `apps/web/test/ironclad-full-09.test.tsx`
- `ops/ironclad-rebuild/task-09-report.md`

## Final evidence and CI

- Pushed implementation: `7da7855ef3950ed0cfb0f2ef26449a0b77b6e677`, only `codex/ironclad-full-ui-09`.
- Actual GitHub CI: [run 38334855757 / CI #1004](https://github.com/parsasalahshori/roofline/actions/runs/38334855757), triggered by the implementation push. **Queued** when checked from GitHub's public run page; no completed job results yet for Platform, v1, E2E, Demo DB (arm64), or Hail service. API access is forbidden, but this run URL/status was read from GitHub HTML rather than inferred.
- Final frontend suite: 150/150; scoped API: 228/228; scoped desktop E2E: 7/7; expanded desktop/phone E2E: 21 passed and the public storm-host test failed on `Domain forbidden`; separate demo walkthrough: 1/1.
- Final typecheck, lint, CSS lint and build exit successfully. Dependency/lockfiles unchanged. Allowlist and whitespace checks pass.
- Final 22 fixture-based captures/axe scans are complete: zero document overflow, zero uncaught page errors, zero scoped WCAG A/AA violations. The final capture server disables map tile configuration for this test process only, as repository test guidance prescribes; no network restrictions were changed. Empty map fixtures have the existing response shape. Geometry inspection also confirmed the texting screen's heading, form and scroll ancestors fit the 390px viewport.
- Visual results SHA-256: `68ee1950a478ac6bfd1455d29d75c53aadd5e54606ee9079c676384ba2638c6a` (`/workspace/work/task09/evidence/visual-checks.json`).
- Evidence check time: 2026-10-12 19:03 PDT.

Task 09 implementation is ready for controller review with the CI queue and public test-host restriction outstanding. This report does not declare exact account-screen fidelity, integrated product readiness, or live-provider readiness.
