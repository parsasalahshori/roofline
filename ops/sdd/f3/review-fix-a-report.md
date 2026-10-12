
# F3 review fixes, group A (web) - branch f3-review-a, commit cf3428c

## Built
- A-r1-download-link: RouterLink passes reloadDocument when `download` is set (providers.tsx, test providers-download.test.tsx).
- B-r2-r3-billing: PlanPicker, BillingTab and ShellBanners show error.message on checkout/portal failure (R2); PlanPicker `current` requires hasPaymentMethod (R3); four new tests in billing.test.tsx.
- C-r4-r5-setup-texting: useLocateCompany and useServiceArea invalidate keys.mapArea (R4); approved-without-number state with copy key gettingNumber (R5); tests in setup.test.tsx and texting.test.tsx.

## Review rounds
- Round 1: verify failed with 1 finding; fixed.
- Contact check 1: F1 approve.
- Round 2: verify passed, 0 findings.
- Minors: prettier --check warns on some touched and untouched files; not reformatted.

## Verify
typecheck, lint, lint:css clean. Web vitest: 42 files, 404 tests passed.

## CI
Run 38195205081 FAILED before starting any job: GitHub annotation "The job was not started because recent account payments have failed or your spending limit needs to be increased." Infrastructure/billing, not code. Branch is pushed; CI needs a rerun once billing is fixed.
