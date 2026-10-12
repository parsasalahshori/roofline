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

## Ruling EP follow-up (lead, before merge)
Commits c217f4d (fix(estimator): the signed PDF proves what was signed (Ruling EP)) and ff18e37 (r2 cast); head ff18e37.
- pdf.ts: ProposalPdfInput.estimateClause (string | null, required); the signature page prints it under the chosen total. makeSignedPdf passes ESTIMATE_CLAUSE_V1 when the company setting is on and the basis is estimate; the proposal PDF route passes null. `signature` gains `timeZone`.
- Audit page "Signing record" after the signature page: signer, typed signature, drawn image (or "none"), signed and first viewed times via formatZonedTime (e.g. "October 12, 2026, 10:00 AM CDT (America/Chicago)"; first viewed "not recorded" when null), IP, user agent, consent version and text, document SHA-256. Zone from companies.timezone via signedPdfSource, checked with isTimeZone, fallback America/Chicago.
- Drawn signature: proposal-sign.ts puts the PNG at companies/<c>/proposals/<p>/signature-<sha256>.png (image/png) after resolveLink and before the signature transaction; makeSignedPdf fetches it, checks sha256, draws it; missing or mismatched throws before any PDF put.
- Minors: consentVersion read from the row (unknown version throws); job transaction throws when attachSignedPdf returns false; PDF CreationDate/ModDate = signedAt (bytes reproducible, verified locally); readStoredFile and storedFileById deleted (the signed.pdf route keeps its single signedPdfFile lookup, so no third variant); r2.ts uses a single `as RequestInit['body']` (CI's DOM types reject the uncast Uint8Array<ArrayBufferLike>, local types accepted it).
- Tests: signed-pdf.test.ts (renderer clause/audit/identical bytes; job clause on, setting off, basis exact; drawn image drawn; mismatched and missing image fail with no PDF put, no file row); proposal-sign.test.ts (PNG stored at the key; failed image store records no signature); proposal-pdf.test.ts updated for the new fields.
- Verify: typecheck, lint clean; @roofline/shared 463 passed; @roofline/web 733 passed. CI run 38236279655 failed on the r2 typecheck only; CI run 38236994245 on ff18e37: Platform passed, E2E passed.
