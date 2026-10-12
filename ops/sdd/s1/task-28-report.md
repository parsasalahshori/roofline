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
