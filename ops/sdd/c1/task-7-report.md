# Task 7 report: C1 customers: view, timeline, notes, server geocoding

Built: P1 (db repos timeline.ts, notes.ts; api routes timeline.ts, notes.ts), P2 (db repo customer-view.ts; GET /api/customers/:id/view; server geocoding on POST /api/properties and POST /api/properties/:id/locate), P3 (tests customer-view, timeline, notes, property-geocode). Existing map, properties, send-batch and weather tests now send lat/lng null where no server lookup is wanted.

Review 1: 3 findings. Contact check: F1 amended, F2 approved, F3 amended. Review 2: 0 findings.

Minors / open choices: archived jobs excluded from home job lists; timeline paging cursor is ms precision (microsecond rows on a boundary can be skipped); addNote actor name has no active-member filter; updateProperty-null returns 404 (extra).
Not run: database-backed tests (no Docker); first real run is GitHub Actions via ci-check.

Verify: npm run typecheck (tsc -b) and npm run lint (eslint .) both exit clean.
