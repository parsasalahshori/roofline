# Task 27 report: C1 Web: Today, command-K actions and recents, map focus, export buttons

Branch c1-t27, commit 5c69617. CI run 38207559490: PASSED.

## Built
- P1-today: Today.tsx, api.ts (GET /api/today), today copy, tests today-crm and today (stub for GET /api/today).
- P2-search: SearchDialog.tsx, searchOptions.ts (actions, recents, external CSV option), search copy, tests search-actions and search-dialog.
- P3-map-focus: MapView.tsx reads ?focus=<propertyId> (UNSAFE_LocationContext, null outside a router), flies to zoom 16 and opens the pin card once; test map-focus.

## Reviews
- Review 1: 1 finding, fixed. Contact check 1: approved.
- Review 2: 0 findings.

## Minors
- Builder 2 wrote tests and implementation together (no red run first).
- Verify needed no changes.

## Verify tail
web vitest: 53 files, 520 tests passed; typecheck, lint, lint:css passed; build:web built in 1.25s (chunk-size warning only).
