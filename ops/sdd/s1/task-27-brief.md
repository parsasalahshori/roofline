### Task 27: Web: Settings → Storm and ad connections

**Base:** `s1-storm` after Task 22 is merged. **[C1]** `ConnectionsTab.tsx` (Ruling CA) for `AdConnections`; Settings → Team (F3 `TeamTab.tsx`) for the alert switch. **[E1]** photo upload via the R2 `ObjectStore`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `StormTab.tsx` (threshold select 0.75–2.00, budget, days, Google share slider, email on/off, templates with defaults and missing-token warnings) + the `GET/PUT /api/storm/settings` route half in `routes/storm-settings.ts` and `POST/DELETE /api/storm/photos` (R2 via E1's `ObjectStore`, ≤ 5 photos, JPEG/PNG ≤ 5 MB); Builder 2 `AdConnections.tsx` (Google: steps with Roofline's manager ID, ID field, status chip, "Check again"; Meta: steps with Roofline's Business ID, ad account ID field, status and reason); Builder 3 Team → "Storm alerts" switch per member (owner/office) + hooks + tests.

**Tests:**
- settings round-trip with validation errors; photos upload and delete; connection flows against stubbed responses; alerts switch.

**Carries and rulings:**
- Vendor names only in `copy/connections.ts`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web,api): Storm settings, ad account connections and storm alert preferences`
