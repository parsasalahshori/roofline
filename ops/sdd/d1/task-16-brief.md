### Task 16: Retention sweep

**Base:** `d1-front-desk` after Tasks 12 and 13 are merged. Real (F1): the customer delete path in `repos/customers.ts`. **[E1]** `ObjectStore` delete.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `system/fd-retention.ts` (per company: recordings older than `recording_retention_days` (spam: 7) → delete from R2 and mark `deleted`; turns older than `transcript_retention_days` (spam: 7) → `text = ''`, `tool_calls` reduced to names); Builder 2 `jobs/scheduler/fd-retention.ts` fan-out + customer-delete hook (F1's delete path calls `purgeCustomerConversations`); Builder 3 tests.

**Files:** Fill the listed files; Modify the F1 customer delete function (one call); Test `apps/api/test/front-desk/retention.test.ts`.

**Tests:**
- boundaries by days; spam 7 days; `recording_retention_days = 0` means calls are never recorded (Task 12 checks it) and nothing to sweep; summaries kept; customer delete purges at once; idempotent.

**Carries and rulings:**
- Turn text is blanked, metadata kept.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Front Desk retention — recordings, transcripts and spam on schedule`
