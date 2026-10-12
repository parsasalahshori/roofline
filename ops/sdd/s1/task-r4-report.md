# Task R4 report: web review fixes

## Built
- A-storm: layer zoom rounded to a whole number clamped 0..22 (query key and URL); "My routes" ghost link in StormWindow (all roles) and a My routes entry in the phone More sheet (now 6 links); planStatus covers all 9 task statuses (`satisfies Record<TaskStatus, string>`); loading skeleton; stat labels "Customers hit" / "Homes hit"; redraft shown for null/draft/expired/declined plans, API 409 message shown in the toast.
- B-ads: ad accounts show lastErrorPlain on pending/error rows; AdAccountReason and connections.reasons removed; AdAccount matches the real row; check/remove hooks return { account }.
- C-minor: EditFieldSpec.inputMode (maxSpend decimal); RouteMap split into marker, position and cleanup effects; --shadow-marker and --shadow-marker-ring tokens.

## Review rounds
- Round 1: verify passed, 0 findings.

## Minors
- s1-t28 e2e risks: More sheet has 6 links, stat labels changed, old ad account reason text removed, redraft button appears beside Open the plan.

## Verify tail
typecheck, lint, lint:css clean; vitest @roofline/web: 96 files, 945 tests passed.

## CI round 1 (run 38251690554)
Platform failed: packages/ui/test/tokens.test.ts "tokens.ts mirrors tokens.css" (29 vs 31). Fix: added shadow-marker and shadow-marker-ring to packages/ui/src/tokens.ts (outside the stated scope, but required by the mirror test). E2E and Hail passed.
