# E1 Task 12 report: homeowner proposal link (view, sign, decline)

Built: A-db (packages/db/src/system/proposal-links.ts, repos/proposal-public.ts), B-public-read (apps/api/src/public/proposal-common.ts, proposals.ts), C-sign-and-tests (proposal-sign.ts, test/proposal-public.test.ts, test/proposal-sign.test.ts).

Review 1: verify passed, 0 findings.
CI round 1 (run 38225790172): Platform failed on test/estimator-skeleton.test.ts (old placeholder expected MESSAGES.notFound for unknown token; brief mandates "This proposal link doesn't work."). Fixed: test updated (commit 8c52055). E2E passed.
CI round 2 (run 38227943070): Platform and E2E passed.

Minors: sign validates body before resolving the token (400 before 404); per-token sign limiter counts 400s; decline event carries no ip/user agent; signed.pdf 404 until T13.
Verify tail: typecheck, lint clean; @roofline/shared 463 tests passed.
