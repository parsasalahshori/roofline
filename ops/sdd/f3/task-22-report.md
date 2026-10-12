
# Task 22 report: usage reporting (meter batches and invoice items)

Built: B1 packages/db/src/repos/usage.ts (openMeterBatches, markBatchReported, unbilledInvoiceUsage, markInvoiced, stripeCustomerIdFor); B2 packages/db/src/system/usage-fanout.ts + apps/api/src/jobs/scheduler/report-usage.ts (no provider call inside a transaction, no queue.ts import); B3 apps/api/test/report-usage.test.ts (five tests).
Review 1: verify passed, 0 findings.
Minors: markInvoiced does not require item id still null (acceptable, only called after successful createInvoiceItem).
Verify: typecheck and lint clean; commit ec35ecd; ci-check PASSED (run 38184733255).
