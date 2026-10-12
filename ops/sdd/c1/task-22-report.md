
# Task 22 report: C1 Web new customer, new job, add a home

Branch c1-t22, commit fcb8cc6.

## Built
- A-new-customer: NewCustomer.tsx and module css, create-customer.test.tsx.
- B-new-job: NewJob.tsx and module css, create-job.test.tsx.
- C-parts-and-shared-tests: AddressFields, CustomerPicker, AddHomeSheet, Create.module.css, create-parts.test.tsx, c1-routes.test.tsx.
- Lead: copy/create.ts and create/api.ts.

## Reviews
- Round 1: 3 findings (R1-1 approve, R1-2 amend, R1-3 approve); fixed. Verify passed.
- Round 2: 1 finding (R2-1 amend); fixed. Verify passed.
- Round 3: 0 findings.
(Finding texts were not passed to the lead; only outcomes are recorded.)

## Minors
- NewJob uses errors.generic for the invalid-value message (no create.newJob.valueInvalid key).
- Blank name is not checked on the client; server error lands under the name field.
- Ledger entry (progress.md) and AGENTS.md update not done here.

## Verify tail
web vitest: 46 files, 451 tests passed; typecheck, lint, lint:css clean; build:web built in 1.72s (chunk-size warning only).
