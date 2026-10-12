# Task 16 report: Setup checklist API

Commit d62490e on f3-t16.

Built:
- B1-db-repo: packages/db/src/repos/setup.ts. Added setupFacts, saveSetupItems and setSetupSkipped. rejectedFields stays string[] and is filtered to BRAND_FIELDS (Ruling X). No import from jobs/queue.ts.
- B2-api-routes: apps/api/src/account/setup-routes.ts. GET /, POST /:key/skip and POST /:key/unskip. Messages are constants in the route file. Deviation: the audit entry uses targetType 'company' and targetId ctx.companyId, because AuditEntry.targetId is a non-null uuid string. The brief said null.
- B3-api-test: apps/api/test/setup.test.ts. Nine brief tests plus two extras (skip writes a setup.skip audit row; unknown key gives 404). Deviation: seedTwoCompanies gives company A four members and an approved texting row, so a helper (makeCompanyANew) disables the non-owner members and deletes the texting row for the tests that need a new company.

Review round 1: verify passed, 0 findings.

Minors: the audit targetId deviation above. The fallback if CI shows a permission error on texting_registrations columns is to drop rejection_reason_plain or rejected_fields from the select.

Verify: typecheck and lint passed (no output errors). CI run 38185228286: Platform job (lint, typecheck, tests) passed; v1 passed; E2E (Playwright) failed (not judged by ci-check by default, and this task touches no web code).
