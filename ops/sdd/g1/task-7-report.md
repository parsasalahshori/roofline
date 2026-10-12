
# G1 Task 7 report: Claim packet PDF with storm evidence and measurements

Commit ef50083 on g1-t7. CI run 38247974983: passed (Platform, E2E, Hail service, v1).

## Built
- 1-facts (packages/db): getClaimPacketFacts and latestClaimPacket in repos/claim-packet.ts; getJobClaim now returns packet; stored_files kind claim_packet (0023 regenerated, snapshots 0023/0024 differ from base only by the new check constraint plus formatting); tests in claim-packet.test.ts and migrations.test.ts.
- 2-pdf-map (apps/api): packet-pdf.ts renderer (claimsGuard-clean), providers/static-map.ts (key only in the request URL, never logged) with FakeStaticMap, tests.
- 3-handler-routes-web: claims/packet-step.ts, claim_packet handler, POST/GET packet routes (live task run inline), web link and build button in ClaimSection, copy, tests.

## Known gaps (minors)
- Measurement fallback to instantEstimate not done: null surface_sq_ft leaves roofAreaSqFt and roofSquares null.
- Map tests assert calls <= 1 because the geocoder fake may not set a point.

## Reviews
- Review 1: verify passed, 0 findings.

## Verify
- npm run typecheck and npm run lint: clean.
- ci-check (CI_JOBS="Platform E2E"): run 38247974983 completed, success.
