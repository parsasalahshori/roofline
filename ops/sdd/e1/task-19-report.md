# E1 Task 19: Web: homeowner page and e-sign

Branch e1-t19, commit 1d6a48d (base fcaced6). CI run 38200594307: PASSED.

## Built
- A-page: HomeownerPage.tsx and its CSS module. Open, signed, declined, expired, 404 and error states; noindex meta; option cards; financing line; call links.
- B-sign: SignFlow, SignaturePad, DeclineSheet (tsx and CSS modules).
- C-api-tests: api.ts (publicFetch, relative /api/public/proposals URLs, credentials omit, record-view once per token), homeowner.test.tsx (14 tests), e1-routes.test.tsx (/p/abc stubs a 404).
- copy/homeowner.ts was also modified (copy keys).

## Review rounds
- Review 1: verify passed, 0 findings.

## Minors / deviations
- Most popular and Estimate labels are plain spans, not ui Pill (Pill without handler renders a button).
- Banner tone is danger (Banner has no error tone).
- Body text 16px in CSS module rather than the 14px token.
- Signed dates use browser local zone; validUntil uses UTC.
- homeowner.comingSoon is no longer used in these tests; lead may remove the key after grepping.
- test helper stubApi cannot answer 204, so the decline stub answers 200 with {}.

## Verify output tail
Web vitest: 46 files, 457 tests passed. typecheck, lint, lint:css clean. build:web: built in 1.21s (chunk size warning only).
CI (ci-check): Platform job passed, run 38200594307.
