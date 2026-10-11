### Task 10: Exact report flow and aerial measure

**Base:** `e1-estimator` after Tasks 7, 8 and 9 are merged. From T7: `routes/measurements.ts` (append two POST routes), `createMeasurement`. From T8: `repriceFromMeasurement`. From T9: adapters. Real (F3): `invoiceAmountCents('exact_report', …)` (`packages/shared/src/billing.ts`), usage events (`repos/usage.ts`), `builtInHandlers`/`StepHandler` (`tasks/runner.ts`), spend approval in R2 (`tasks/service.ts`).

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `repos/exact-reports.ts` and `estimator/exact-report.ts` (price → draft task; the step handler); Builder 2 `jobs/scheduler/exact-report-poll.ts` + `system/exact-report-fanout.ts` (poll, complete → exact measurement → reprice → usage); Builder 3 aerial measure (`POST /api/measurements/:id/aerial`) and tests.

**Files:** Modify `packages/db/src/repos/exact-reports.ts`, `packages/db/src/system/exact-report-fanout.ts`, `apps/api/src/estimator/exact-report.ts`, `apps/api/src/jobs/scheduler/exact-report-poll.ts`, `apps/api/src/tasks/handlers.ts` (`order_exact_report` → `orderExactReport`), `apps/api/src/routes/measurements.ts` (append the two POST routes — coordinate: Task 7 is merged first); Test `apps/api/test/{exact-report,aerial}.test.ts`.

**Interfaces:**
```ts
export async function requestExactReport(deps: AppDeps, ctx: TenantContext, measurementId: string): Promise<{ taskId: string; orderId: string }>;   // price → order row 'priced' → agent task (estimator, kind 'exact_report') with one order_exact_report step; maxSpendCents = invoiceAmountCents('exact_report', 1, price.maxCents, billingConfig)
export const orderExactReport: StepHandler;   // claim priced→ordering (expired price → re-price; if the new max exceeds the approved max → needs attention "The report price went up. Ask again."); order; waiting; ExactOrderUncertainError → order 'attention' + step needs_attention with the plain v1 message; never retried
export async function pollExactReports(deps: AppDeps, now: Date): Promise<void>;   // fan-out waiting orders (last_polled_at ≤ now − 10 min), per company withTenant
export async function completeExactReport(deps: AppDeps, ctx: TenantContext, orderId: string, r: ExactReport, costCents: number, now: Date): Promise<void>;   // exact measurement (method eagleview, kind exact, outline copied), usage event once (ref ('exact_report', reportId), description 'Exact roof report — <address>'), reprice open proposals (Task 8), activity, order complete
export async function aerialMeasure(deps: AppDeps, ctx: TenantContext, measurementId: string): Promise<MeasurementView>;   // when settings.aerial_measure && deps.aerial.configured: start, poll inline every 3 s for up to 60 s, else 503 "Aerial measure is taking longer than usual. Try again in a minute."; on complete a new measurement (method 'aerial') with the main structure's area and pitch
```
- **Routes:** `POST /api/measurements/:id/exact-report` (owner or office may request; the spend approval decides) → 201 `{ taskId }`; 503 when not configured "Exact reports aren't set up yet."; `POST /api/measurements/:id/aerial` → 201 `MeasurementView` (403 when the company setting is off).

**Tests:**
- request → task with the max spend preview; office approval leaves the step `awaiting_owner`; owner approval orders once; drain twice → one order call; uncertain → attention, no second call; expired price within max → re-price then order; poll pending then complete (fake `complete`) → exact measurement, one usage row (4,500 cost), a draft proposal re-priced, a sent proposal revised; aerial on/off, fake pending then complete, outage → fallback message.

**Carries and rulings:**
- An uncertain order is never retried; the usage event is recorded once per report (Review Focus 3).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(estimator): owner-approved exact reports, re-billing and re-pricing; aerial measure`
