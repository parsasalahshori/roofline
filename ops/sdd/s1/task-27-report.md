# Task 27 report: Web: Settings, Storm tab and ad connections

## Built
- P1-api: storm settings routes (photos raw-body, settings audit), team storm-alert flag (team route, db team, team-store), tests.
- P2-stormtab: Settings Storm tab (form, templates, photos), stormApi hooks, copy/storm.ts, tests.
- P3-ads-team: AdConnections (Google, Meta), adsApi, Connections tab, Team tab storm-alert toggle, copy (one Meta name, one coming-soon line; ads.ts removed), tests.

## Review rounds
- Round 1: verify passed, 0 findings.

## Minors
- Photo upload race can orphan a stored object (rare). DELETE photo keeps stored_files (no DELETE grant).
- Ad account API shape is assumed (T16 must match): GET /api/ads/accounts -> {accounts, managerId, businessId}.
- Storm emails toggle semantics (emailEnabled) to confirm against spec.
- Ledger (progress.md) and AGENTS.md not updated by builders.

## Verify tail
typecheck, lint, lint:css clean; web vitest: 48 files, 482 tests passed.
