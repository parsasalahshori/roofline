### Task 21: Web: Front Desk window and stats

**Base:** `d1-front-desk` after Task 20 is merged. Real (F2): `apiFetch`, `StatCard`, `Pill`, `Skeleton`.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `FrontDeskWindow.tsx` (list with filters, unread, outcome chips, live call rows with a pulsing dot, polling 5 s while any call is live, else 30 s); Builder 2 `WeekStats.tsx` (numbers in a row of stat tiles; AI minutes as "212 of 500 minutes"); Builder 3 hooks + tests; empty state "No calls yet. Once forwarding is on, every call shows up here."

**Carries and rulings:**
- Live calls poll every 5 s only while a call is live.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): Front Desk window — calls and texts with this week's numbers`
