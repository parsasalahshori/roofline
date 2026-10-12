### Task 26: Web: phone routes

**Base:** `s1-storm` after Task 22 is merged. Real (F2): `useIsPhone`, `Sheet`, `Button`; F2 phone shell (`shell/phone/*`).

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `MyRoutes.tsx` (list of the rep's routes with progress); Builder 2 `RouteView.tsx` (map with stops numbered, list in order, the rep's dot from geolocation when allowed, "Navigate" link `https://maps.apple.com/?daddr=` on iOS and `https://www.google.com/maps/dir/?api=1&destination=` otherwise); Builder 3 `DoorOutcome.tsx` (five 48px buttons; "Wants a check" sheet with name, phone, email, "OK to text about this" unchecked, note) + hooks + tests.

**Tests:**
- outcomes post and move to the next stop; wants-check sheet validation; offline-safe message on network failure ("Not saved — try again"); 375px no horizontal scroll (unit snapshot of layout classes; e2e does the real check).

**Carries and rulings:**
- 375px no horizontal scroll is checked again in T28.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): door-knock routes on the phone`
