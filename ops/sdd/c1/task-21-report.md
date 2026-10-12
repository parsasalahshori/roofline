# Task 21 report: C1 Web customers list and customer window

Commit 447a369 on c1-t21. CI run 38206025415 PASSED.

## Built
- A-customers-list: CustomersWindow (+css), customers-list.test.tsx. Debounced search (?q=), client-side tag/texting filters (follow-up: server filter), archived toggle, table/phone list, New customer, owner/office CSV download, paging above 50, skeleton/empty/error states.
- B-customer-window: CustomerWindow, CustomerHeader, CustomerHomes (+css), customer-window.test.tsx. Labelled sections, archive confirm, edit sheet, addHome=1 sheet, company-zone dates, recent record.
- C-edit-sheet: EditCustomerSheet (+css), customer-edit.test.tsx (9 tests), c1-routes.test.tsx update.

## Reviews
- Review 1: verify failed, 1 finding. Contact check 1: F1 amended.
- Review 2: verify passed, 0 findings.

## Minors / deviations
- Patch sends smsConsentStatus 'written' with a non-blank consentNote even if unchanged (server checkNote requires it).
- c1-routes.test.tsx: extra empty-list stub for the Customers tab test.
- Save disabled on blank name (no copy for required); not covered by a test.
- Tags render as neutral Pills (dead buttons); job Pill links to the job.
- Follow-ups: server tag/texting filters; city and jobs count columns once the list endpoint returns them.

## Verify tail
web vitest: 53 files, 547 tests passed; typecheck, lint, lint:css clean; build:web built in 1.29s (chunk-size warning only).
