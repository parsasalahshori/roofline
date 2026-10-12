# E1 Task 13: Signed PDF and object storage (R2)

Branch e1-t13, commit aafa40f.

## Built
- A-r2: apps/api/src/providers/r2.ts (R2ObjectStore on aws4fetch, r2For), test apps/api/test/r2.test.ts, fixtures apps/api/test/fixtures/r2/. Private bucket, no public or presigned URLs, errors carry status codes only.
- B-repo: packages/db/src/repos/stored-files.ts (storeFile, attachSignedPdf, signedPdfSource, link token read).
- C-job: apps/api/src/estimator/signed-pdf.ts (makeSignedPdf: idempotent, object put first then stored_files row, deterministic key, sha256 on file and signature, one email with the signed.pdf API link per Ruling EE), handlers.ts wired, apps/api/test/signed-pdf.test.ts.

## Review rounds
- Round 1: verify passed, 0 findings.

## Minors
- No-email case is a separate test, 'sends no email when the customer has none'.
- Mail failure is swallowed without logging so it never retries the job.
- Not locally verified: T8 renderer signature page content (asserted by test 2 on CI).

## Verify
typecheck, lint clean; vitest @roofline/shared 23 files / 463 tests passed.
CI run 38233224802: Platform passed, E2E passed.
