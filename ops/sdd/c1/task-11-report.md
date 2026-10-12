
# Task 11: C1 Microsoft Graph adapter (commit 553efb9, branch c1-t11)

## Built
- adapter: apps/api/src/providers/microsoft-calendar.ts (MicrosoftCalendarApi, microsoftCalendarFor; returns null unless MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are set).
- fixtures: 11 files in apps/api/test/fixtures/microsoft-calendar/.
- tests: apps/api/test/microsoft-calendar.test.ts (19 groups, 29 cases).

## Review rounds
- Round 1: verify passed, 0 findings.

## Minors
- calendar.ts and microsoft-calendar.ts import each other (safe: nothing used at module evaluation).
- Judgment calls: missing/non-numeric expires_in is unavailable; empty scope falls back to defaults; listCalendars follows nextLink with no page cap; error bodies read only for code.
- Tests were not run locally (apps/api vitest globalSetup needs Docker); CI will run them. Test-first not strictly observed.

## Verify
typecheck (tsc -b) and lint (eslint .) both passed with no output errors.
