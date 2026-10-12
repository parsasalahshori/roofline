# G1 Task 14 report: Follow-up agent, review requests

Branch g1-t14, commit ce633d9. CI run 38247529854: PASSED (Platform and E2E jobs).

## Built
- A-finder (packages/db): findReviewCandidates in follow-up-finder.ts (completed latest install, at most 30 days old, local-day delay, review log and recent-reply exclusions, one candidate per customer); export added in index.ts; 10+1 tests in follow-up-finder.test.ts.
- B-draft (apps/api): draftReviewTexts with Llm validation (length 320, claimsGuard, link, STOP line) and template fallback; test followup-review-draft.test.ts.
- C-daily (apps/api): review group in daily.ts (REVIEW_CAP 25, gated on followupReviews flag and non-empty reviewLink, kind 'review' send step); 12 tests in followup-reviews.test.ts.

## Reviews
- Review 1: verify failed, 1 finding; fixed in the build before finalize (details in the lead's review log).
- Contact check 1: F1 approved.
- Review 2: verify passed, 0 findings.

## Minors
- Builder 1 and 3 wrote tests after implementation and could not run DB tests locally; CI ran them.
- Finder leaves settings flags to the caller by design.

## Verify
typecheck and lint: clean, no changes needed. ci-check: Platform job passed, E2E job passed, PASSED (run 38247529854).
