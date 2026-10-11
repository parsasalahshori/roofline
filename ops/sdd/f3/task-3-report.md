# F3 Task 3: Shared billing config and metering math

Built: p1 packages/shared/src/billing.ts (constants, lookup keys, tiers, meterUnits, invoiceAmountCents, parseBillingConfig, planByKey); p2 config/billing-plans.example.json and db enums.ts re-export of USAGE_KINDS/UsageKind from @roofline/shared; p3 packages/shared/test/billing.test.ts.
Deviation: unknown-key errors use the dotted path of the key as message.
Review 1: verify failed, 1 finding, fixed. Contact check: F1 approve. Review 2: passed, 0 findings.
Minors: none.
Verify: typecheck, lint clean; shared vitest 8 files / 222 tests passed; web copy-rules 5 passed.
Commit b857c5d. CI run 38180141961 PASSED.
