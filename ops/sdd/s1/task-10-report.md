# Task 10 report: Alerts and the settle trigger

## Built
- P1 db: packages/db/src/repos/storm-alerts.ts (getAlertFacts, alert recipients, claim alerted_at), packages/db/src/system/hail-health.ts (newestProcessedRunAt), tests in storm-alerts-repo.test.ts, rls.test.ts, apps/api/test/storm-config.test.ts (OPS_ALERT_EMAIL).
- Ruling AW amendment: 0018_storm_grants_rls.sql amended in place (new section 9: SELECT ON hail_runs TO app_system; company_members view replaced with storm_alert_email as last column, app_tenant SELECT restated; section 8 comment updated). Journal and snapshots untouched. Two rls.test.ts assertions updated accordingly.
- P2 api: storm/alerts.ts (sendStormAlert, alertNow, alertPlanReady; claim in same transaction as the reads, sends after, each wrapped with reportJobError); handlers.ts validates companyStormId and kind in storm-draft and storm-alert.
- P3 api: storm/settle.ts (SETTLE_MINUTES, shouldDraft, afterMatch), match.ts calls afterMatch, scheduler/hail-health.ts (stale threshold, first tick after crossing emails ops; falls back to reportJobError without OPS_ALERT_EMAIL).

## Review rounds
- Review 1: verify passed, 0 findings.

## Minors
- settle test uses agent_tasks status 'approved'; unverified against TASK_STATUSES (CI will show).
- storm-alerts test seeds an extra user by INSERT copying password_hash; check that first if CI shows a column mismatch.
- Plan-email body wording is the builder's.

## Verify
typecheck and lint clean; vitest @roofline/shared 28 files, 657 tests passed. DB-backed suites run on CI only.
