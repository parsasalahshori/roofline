
# Task 3: Shared tiers and financing (branch e1-t3, commit 8c35f6b)

## Built
- P1-templates: packages/shared/src/tiers.ts (TierTemplateSchema, AddOnSchema, DEFAULT_TIER_TEMPLATES; Better/Best highlights trimmed to 4 per lead ruling, flag to controller), test/tiers-templates.test.ts.
- P2-price: packages/shared/src/tiers-price.ts (addOnQuantity, withAddOns, priceTier; waste applied to per_square in priceTier), test/tiers-price.test.ts.
- P3-finance: packages/shared/src/tiers-finance.ts (monthlyPaymentCents; extra RangeError on non-finite principal), test/tiers-finance.test.ts.

## Reviews
- Round 1: verify failed, 1 finding; contact check F1 = amend (amended).
- Round 2: verify passed, 0 findings.

## Minors
- Brief's test/tiers.test.ts name replaced by tiers-templates.test.ts.
- Non-finite principal deviation in monthlyPaymentCents.

## Verify tail
- vitest @roofline/shared: 18 files, 400 tests passed. typecheck and lint clean.
- ci-check: run 38194921319 PASSED.
