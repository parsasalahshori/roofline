# Task 28 report: e2e, acceptance map, docs

Packages
- P1-infra: seedStormFixture (apps/api/src/scripts/storm-fixture.ts), e2e fixtures/stack/playwright config (POLICY_PAGES_DOMAIN, host-resolver rule), README Storm Scout section, OPS_ALERT_EMAIL in .env.example.
- P2-storm-a11y: storm.spec.ts (plan in 2 clicks, five steps Done), a11y.spec.ts additions.
- P3-doors-phone-acceptance: doors.spec.ts, phone.spec.ts S1 test, docs/superpowers/s1-acceptance.md.

Review 1: verify passed, 0 findings.

Minors / follow-ups
- Door and landing leads appear on the REP's Today, not the owner's (today.ts scoping; landing leads have no assignee). Possible spec gap, needs a ruling.
- Results UI has no campaigns/routes counts (ruling AY); spec asserts texts sent and ad spend only.
- Seed and specs are untested locally (no Docker); proof is CI "Platform E2E Hail".
- phone.spec waits for 'Storms in your area' as heading; a11y waits for region. Confirm on CI.

Verify: typecheck, lint, lint:css clean; playwright --list: 52 tests in 13 files.

CI rounds (ci-check "Platform E2E Hail"; Platform and Hail jobs passed in every round)
- Round 0, run 38242124205 @290680d: E2E failed. POST /api/storms/:id/plan and /storm/:id take the company_storms id, not storms.id. Fixed (5c06a77): specs and draftAndApproveStormPlan use scenario.companyStormId.
- Round 1, run 38244724811 @5c06a77: E2E failed. (a) axe nested-interactive on the storm swath map (role img with focusable MapLibre attribution): fixed in ec8d9cf by making it role region like the measure map (storm-detail.test.tsx updated). (b) strict-mode match on the 'Text ' row: now /^Text /. (c) plans stuck: waitForStormSteps now names unfinished steps.
- Round 2, run 38248017373 @ec8d9cf: E2E failed. Storm detail a11y now passes. Diagnosis from the step report: send_sms_batch and send_email_batch stay 'running' with scheduled:12 (held by quiet hours: CI ran at about 7am in the company zone America/Chicago); ads and routes finish. Fix (committed, NOT yet run on CI because the 2-rerun limit was used): seedStormFixture sets companies.timezone to a zone where it is mid-day (daytimeZone).
- Open: the office-approves test's 'Text ' row stayed pending in round 1; likely the same quiet-hours hold or a click race, recheck on the next CI run.

CI round (run 38250663843 @0909fb5: 49 passed, 3 failed)
- PRODUCT bug: landing form POST left the browser on /api/public/storm-requests/<code>. helmet's default Referrer-Policy no-referrer makes browsers send `Origin: null` on the form's POST, so stormRequestOriginGuard answered 403 JSON. A real homeowner would have hit it. Fix: the storm landing page (public/storm-page.ts) sets Referrer-Policy same-origin; test added in apps/api/test/storm-page.test.ts.
- PRODUCT bug (a11y): route view map had role img with focusable MapLibre attribution links (axe nested-interactive); RouteMap.tsx is now role region with the same label, like the swath and measure maps.
- TEST bug: phone.spec waited for a heading 'Storms in your area'; the Storm window's list is a labelled section (region), as a11y.spec already used. Spec now waits for the region.
- Fixture: daytimeZone window widened to local 9..19 and Europe/Berlin, Asia/Dubai added so every UTC hour has a zone (checked for 4 months of the year); apps/api/test/storm-fixture-zone.test.ts covers it (CI only).
- Rename: 'reaches the owner Today' is now 'reaches the rep Today' in doors.spec and docs/superpowers/s1-acceptance.md.
