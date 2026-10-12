
# Task 33 report: Web: the Billing tab and the banners

Commit 919b204 on f3-t33. CI run 38189756699 PASSED.

Built:
- P1-billing-tab: BillingTab, PlanPicker, UsageMeters (+ CSS modules) in apps/web/src/features/billing.
- P2-shell-banners: ShellBanners (trial ended / canceled warning with plan link; past due danger banner with portal button for owners, ask-owner text for others).
- P3-tests: billing.test.tsx; settings.test.tsx and f3-routes.test.tsx updated (billing.later removed).
- Carry: .banners z-index 25 -> 24 in Shell.module.css.

Review 1: verify passed, 0 findings.

Minor: the "Invoices and card" portal button has no onError toast (one-line follow-up in BillingTab.tsx).

Verify tail: typecheck, lint, lint:css clean; web vitest 37 files / 368 tests passed.
