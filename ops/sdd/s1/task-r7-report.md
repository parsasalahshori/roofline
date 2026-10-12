# Task R7 report

Built: db-merged (storm-api.ts, storm-alerts.ts, storm-plans.ts, storm-merged-hidden.test.ts); api-config-settle (settle.ts, hail-health.ts, config.ts, .env.example, README, tests); hail-python (source.py, writer.py, run.py, main.py, README, tests).

Decision (Ruling BE area): a company_storms row whose storm was merged is hidden from lists/summary while plan_task_id is null, visible once a plan exists. Alerts and settle candidates always ignore merged storms; unalerted bound is 3 days. afterMatch calls alertUnalerted once per run.

Review 1: 1 finding, fixed (loadStormPlanFacts in storm-plans.ts gets the same merged-hidden filter). Contact check: approve. Review 2: 0 findings.

Minors: POSTMARK_TOKEN preferred over deprecated POSTMARK_SERVER_TOKEN; _closing_key waits until 12:20Z; 3-day give-up for open convective days; replace mode skips geometry union in writer.
Also touched: apps/api/test/helpers.ts and config.test.ts for new config fields.

Verify: python syntax ok; typecheck, lint clean; shared vitest passed; drizzle-kit: "No schema changes, nothing to migrate".
