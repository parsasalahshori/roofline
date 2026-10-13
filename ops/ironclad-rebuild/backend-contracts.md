# Ironclad redesign: application contracts and regression gates

## Verified baseline and scope

Audited `origin/launch-rc3` at `ff772d5cbf87eac051759e9049fb29930845a45f` on 2026-10-12. This is the full-application baseline. The earlier `f2-shell-wbg3ja` / `0fa8126` contains F1/F2 runtime and placeholders despite later milestone claims in its documentation; it is not a substitute for this baseline. Across API, web and shared source the full branch adds roughly 73,500 lines in 748 changed files.

This document records preservation requirements, not test results. The audit read code and existing tests; it did not run suites, start services, migrate databases or exercise live providers. All ten redesign sessions must use GPT-6 Astra as requested by the owner; historical Claude team-script model assignments do not apply.

Frontend enhancements must retain every existing workflow, error state, permission boundary and asynchronous state. Reuse current hooks and wire types. Do not replace working feature screens with demonstrations, static sample data or inert controls. Cosmetic scopes do not authorize changes to API routes, worker behavior, migrations, provider adapters, shared domain enums or send-gate rules. Coordinate necessary contract changes with the integration owner before implementation.

## Session, company and role boundaries

- `apps/web/src/api/client.ts` owns same-origin authenticated requests, JSON parsing, cancellation, `ApiError.status`, `field` and `latest`, and unauthorized handling. Preserve form-local 401 behavior (`redirectOn401: false`). Show server field errors beside fields and other actionable errors visibly.
- `apps/web/src/api/hooks.ts` clears cached data on login/logout. Company switching updates the account, navigates home, then resets other queries. Preserve this ordering and discard old-company selections, pins, drafts and detail pages. A closed menu must not cancel these follow-up operations.
- Keep API response shapes in `apps/web/src/api/types.ts` and the feature/shared types. Do not import server or database implementation into browser code.
- `apps/api/src/permissions.ts`, live session middleware and database repository scoping are authoritative. Preserve owner/office/rep differences, delegated spend approval, rep-assigned data and hidden monetary totals. An absent private field must not be filled with a guessed value or a demo value. Reps may see price-list prices used to quote homeowners; this does not grant visibility to hidden job values.
- Company/team editing remains operational. Retain mutation invalidations in `features/settings/api.ts`, particularly refreshing account and approvals when membership permissions change.
- Preserve deep links and auth entry points in `apps/web/src/app/router.tsx`, including signed-out public routes. Maintain isolated window errors and map error recovery; one failed screen must not remove all navigation.

## Billing and read-only behavior

`apps/api/src/billing/read-only.ts` distinguishes `trial_ended` and `canceled` from `past_due`. Trial-ended/canceled companies retain reads and access to auth, billing recovery and the Today marker. Most writes are refused with a user-facing 403. Transfer-phone setup is still blocked even though it is under `/api/me`.

Turning Front Desk **off** through `PUT /api/front-desk/settings` with `enabled: false` remains permitted. Do not accidentally disable that safety control with a blanket read-only wrapper. Enabling Front Desk or editing other settings remains blocked. Public customer routes retain their separate behavior. `past_due` instead affects texting through the send gate; do not conflate these statuses.

Preserve actual billing/setup/texting/import workflows in `account/{billing-routes,setup-routes,texting-routes}.ts`, `routes/{imports,export}.ts` and `features/{billing,setup,texting,imports,signup,demo}/api.ts`: checkout/recovery, registration states, checklist progression, upload/preview/import progress, errors and export actions.

## Approvals, messages and asynchronous work

- `features/approvals/api.ts` and `toReviewStep.ts` retain versioned edits and approval requests, conflict reconciliation, polling and cache invalidations. Approval sends `{steps: [{id, version}]}` representing the current waiting steps, including those another role must approve. Keep server-provided `canApprove` and pending-edit guards.
- Preserve optimistic single-step rollback; rolling back a whole stale snapshot can erase a neighboring successful mutation. A 409 reconciles `latest` or refetches as the existing hook prescribes. Do not hide the conflict behind a success toast.
- Retain decline, retry, rerun, expiry, queued/running/completed/failed states and the distinction between preparing a plan, approving it and executing its steps. Read the full-baseline implementation for rerun rules; do not copy older F2 assumptions.
- Sending a proposal or drafting a storm plan returns `{taskId}`. This means a task exists, not that delivery or paid work has completed. Continue into the existing approval/status flow.
- All outbound contact stays behind `packages/send-gate` and `apps/api/src/messaging/*`. Do not introduce direct browser-to-provider calls or bypass consent, opt-out, billing, rate/quiet-hour and approval checks.
- Preserve inbound routing in `apps/api/src/hooks/twilio.ts`: compliance keywords first, Storm handling, G1 Claims, then Front Desk; a consumed message must not be independently processed again.

## Feature contracts

| Area | Existing contract and source of truth |
| --- | --- |
| CRM | `routes/{customers,properties,jobs,notes,timeline}.ts`; browser `features/{customers,jobs,job,create,timeline}/api.ts`. Preserve search/paging, create/edit, assignment, stage changes, lost-reason prompts, archive/restore, notes and timeline, customer/property associations and role filtering. |
| Calendar | `routes/{appointments,calendar,calendar-connect}.ts`; `features/{appointments,calendar}/api.ts`. Preserve scheduling/editing, availability/conflicts, company time zone and external calendar connection/sync states. |
| Quotes | `routes/quotes.ts`, `features/quotes/api.ts` and `draft.ts`. Preserve saved draft calculation/frozen prices, finalization, read-only final quote, copy-to-new-draft and `/api/quotes/:id/pdf`. Do not present an unsaved visual calculation as a persisted quote. |
| Estimator | `routes/{measurements,tier-templates,estimator-settings,proposals}.ts`; `features/{estimator,measure,proposals}/api.ts`. Preserve property/address measurement, report ordering/approval, tier/options pricing, proposal creation/edit/revise, grouped status pagination and send approval. Existing build body contains `measurementId`, optional `jobId` and customer; measurement accepts property ID or address. |
| Front Desk | `routes/{conversations,calls,front-desk,transfer-phone,blocked-numbers}.ts`; `features/front-desk/{api,inbox-api,conversation-api}.ts` and `settings/*-api.ts`. Preserve inbox filtering, live/idle polling, read/unread, attention badges, transcript/action cards, recordings, staff replies, assistant/team handling, spam and blocked numbers, settings, forwarding verification, recording acknowledgment and transfer phone. |
| Storm | `routes/{storms,door-routes,storm-settings,ads}.ts`; `features/storm/api.ts` and `features/storm/routes/api.ts`. Preserve list/detail, dismiss, plan draft/re-draft and pause conflicts, storm map layer, door route workflows, settings, ads and results. Preserve message-versus-spend approval roles. |
| Agents | `routes/{agents,agents-feed,agents-settings,claims,agent-values}.ts`; `features/{agents,claims}/api.ts`. Preserve overview/detail/feed/waiting, period filters, pause confirmation, default paused agents, run-now cooldown, approval navigation, claims packet, time baselines and recount/dry-run behavior. |
| Map/Today | `api/hooks.ts`, `shell/map/*`, `features/today/api.ts`, `routes/{map,today,weather}.ts`. Preserve service-area bounds, points/clusters union, `[west,south,east,north]` ordering, layer controls and selection/navigation, weather/empty/error states, summaries and Today acknowledgment. |

Front Desk mutation hooks deliberately invalidate conversations, detail, stats and unread-count queries rather than all settings/voices. Preserve that behavior and `refetchIntervalInBackground: false`. A staff reply and handing a conversation to the team are distinct actions. Turning on the service must preserve number/forwarding checks and owner acknowledgment paths.

## Public homeowner and storm workflows

`features/homeowner/api.ts` uses **no cookies** (`credentials: 'omit'`) and does not redirect a homeowner to staff sign-in on 401. Preserve `/api/public/proposals/:token` paths and token encoding. Signing sends `optionId`, explicit `consent: true`, `signerName`, `typedSignature`, and optional `drawnSignature`. Do not preselect or fabricate consent/signatures.

Keep view recording once per mount, decline, invalid/expired/revoked link handling and contact recovery. A 410 carries contact information in the error body. Signing 409/410 invalidates the public proposal query so the page reflects its latest state. Signed PDFs can be asynchronous: the current hook polls every five seconds up to 24 reads and exposes `/signed.pdf` only according to returned readiness. Do not replace this with an unconditional download or indefinite spinner.

Server sources are `apps/api/src/public/{proposals,proposal-sign,proposal-common}.ts`. Storm public forms, policy pages and unsubscribe remain in `public/{storm-page,storm-requests,policies,unsubscribe}.ts`; preserve explicit consent, validation and privacy headers. A staff shell redesign must not intercept public links or add staff-session requirements.

## Existing regression evidence to preserve

The baseline includes these meaningful browser suites under `apps/web/e2e/`:

- `crm.spec.ts`: board, stage drag/Lost reason, new job, timeline, quote finalization/PDF and rep isolation.
- `estimator.spec.ts`: address-to-send and exact-report spend approval; `homeowner.spec.ts`: public proposal flow.
- `front-desk.spec.ts`: live/unread inbox, transcript/read state, badge refresh, staff reply/handling, spam, rep restriction, settings, acknowledgment and forwarding verification.
- `storm.spec.ts`: storm plan and office-message/owner-spend approval; `doors.spec.ts`, `public-forms.spec.ts`: related field/public workflows.
- `agents.spec.ts`, `agents-settings.spec.ts`, `more-agents.spec.ts`: agent cards/pause/run/cooldown/feed/waiting, claim packet and weather-move approval.
- `calendar.spec.ts`, `setup.spec.ts`, `billing.spec.ts`, `import.spec.ts`, `signup.spec.ts`, `approvals.spec.ts`, `today.spec.ts`, `shell.spec.ts`, `phone.spec.ts`, `a11y.spec.ts` and `demo-walkthrough.spec.ts` cover the remaining integration surfaces.

API tests under `apps/api/test/` additionally cover calendar provider fakes/sync, proposal signing/PDF, read-only rules, storm pause/rerun, claims and agents. `front-desk/` covers voice hooks, relay, conversation routes, forwarding, recordings/playback, retention, scenarios, tools and inbound gates. These protect backend semantics independently of presentation.

Keep behavioral assertions while adapting deliberate visual/navigation changes. Do not weaken permissions, conflict, readiness or delivery checks to make a redesigned screen pass. If a new navigation structure is not covered, add focused integration proof for company switching, role-specific entry points, canceled-company billing recovery and Front Desk off, stale approval conflicts and public signing continuity. Existing tests are coverage, not proof the new integrated UI passes.

## Required verification gates

Node must satisfy the repository requirement (22.13+); use the lockfile. `npm ls playwright-core` must resolve only pinned version 1.56.1. Cloud builders should run the relevant focused tests while iterating; the integration owner verifies the assembled result.

```sh
npm ci
npm ls playwright-core
npm run typecheck
npm run lint
npm run lint:css
npx vitest run --project @roofline/web --project @roofline/ui --project @roofline/shared --project @roofline/send-gate
npm run build:web
```

With Docker available, full regression includes:

```sh
npm test
npm run e2e -- --project desktop --project phone
```

The separate demo walkthrough runs from `apps/web` with `npx playwright test -c playwright.demo.config.ts`. Follow its isolated demo configuration; do not point resets at real data. Without Docker, use `npx playwright test --list -c apps/web/playwright.config.ts` only to validate discovery, and report that it is not execution. CI remains the integration gate.

The verified `.github/workflows/ci.yml` has five jobs: Platform (lint, CSS lint, typecheck, shellcheck and all workspace tests); v1 tests; Playwright desktop/phone plus separate demo walkthrough; ARM64 demo database; Python hail lint/tests and image build. Require the relevant actual run results, not a claim copied from an older branch ledger. Documentation-only pushes do not start CI.

## Environment, public repository and provider limits

- Preserve CSS Modules, shared UI controls and copy rules: text belongs in `apps/web/src/copy/*.ts`; no raw web `<button>`; shared UI accepts text through props. Preserve keyboard, focus, screen-reader and mobile behavior.
- API CSP limits remote resources. Check `apps/api/src/app.ts` before adding external fonts, scripts or images; prefer bundled assets compatible with the existing policy.
- Assign shared tokens, router, Shell, UI exports and lockfile to explicit owners to avoid ten-session overlap. Backend improvements need separately owned, reviewed scope.
- Repository is public. Never commit secrets, `.env`, tokens or real customer data. Do not expose them through tool output. Do not use live credentials for visual QA.
- The local checkout is under Documents; historical ledger records iCloud zero-byte Git blob hazards. Inspect committed asset/file sizes before publishing.
- Faked CI and demo success cannot establish real-provider readiness. Real Google/Outlook OAuth/sync, carrier/voice forwarding, billing, ads, EagleView, recording storage and messaging delivery require the documented owner smoke tests and configured accounts. Do not spend money, contact real people, create accounts or enter credentials as part of this redesign without explicit authorization.
- Keep provider seams and fake adapters intact. Report separately: implementation complete, automated checks passed, and any live-provider checks not performed.
