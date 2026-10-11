### Task 15: Web: Estimator window and the address flow

**Base:** `e1-estimator` after Task 14 is merged (T7/T8/T11 for the real API; unit tests stub `fetch`). Real (F2): `apiFetch`, `UiLink`, `Field`, `Sheet`. **[C1]** From C1 T22: `CustomerPicker` (`features/create/CustomerPicker.tsx`) may be imported for the typeahead; do not edit it.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `EstimatorWindow.tsx` (address box with typeahead over customers' homes and a geocode-on-submit path; grouped lists); Builder 2 `MakeProposal.tsx` (the one-click "Make proposal": measure → build → send draft → open the R2 review; a new-customer mini form with name, phone, "They asked for this proposal by text"); Builder 3 `features/estimator/api.ts`, `copy/estimator.ts`, tests.
- **Hooks:** `useProposals(filter)`, `useMeasure()` (POST measurements), `useBuildProposal()`, `useSendProposal()` → navigate to `/approvals/<taskId>` (F2 review) .
- **Click budget:** type the address → "Make proposal" (1) → review → Approve (2); when the outline isn't found, "Make proposal" opens the measure view in draw mode instead (the spec's ≤ 3 still holds: draw → "Make proposal" → Approve).

**Tests:**
- the grouped lists from stubbed data; "Make proposal" posts measure, build, send in order and navigates to the review; draw-mode branch; new customer path sends `askedByText`.

**Carries and rulings:**
- Files (plan file structure): `apps/web/src/features/estimator/{EstimatorWindow,MakeProposal}.tsx`, `features/estimator/api.ts`, `copy/estimator.ts`; test `apps/web/test/estimator.test.tsx`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): Estimator window — type an address, make a proposal`
