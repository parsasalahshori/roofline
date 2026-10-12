### Task 7: Claim packet PDF

**Base:** `g1-agents` after Task 6 is merged. **[S1]** `storm_hits`, `spotter_reports`, `storms` (S1 T1/T8/T9). **[E1]** measurements (`getMeasurement`, E1 T7), `ObjectStore`/`storeFile` (E1 T13). **[C1]** `PDF_COLORS` and the pdfkit setup (C1 T16).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 facts gathering (S1 hail at home on date of loss, spotter reports ≤ 10 miles, E1 measurement, inspection, intake); Builder 2 PDF layout with C1's renderer + static map image (MapTiler static API through a small `StaticMap` seam with a fake); Builder 3 `build_claim_packet` handler → R2 + `stored_files`, download route; tests (text extraction asserts the "Radar-estimated" line and measurement label).

**Carries and rulings:**
- "Radar-estimated" on every hail line.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): claim packet PDF with storm evidence and measurements`
