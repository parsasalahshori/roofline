### Task 24: Web: forwarding guide and test

**Base:** `d1-front-desk` after Task 20 is merged. From T3: `forwardingSteps`, `CARRIERS`. **[C1]** `features/setup/SetupRow.tsx` (last edited by **[E1]** T18 and **[S1]**) — add the `phone_number` action only.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `ForwardingGuide.tsx` (carrier picker, mode all/no-answer, codes from `forwardingSteps` in large type with copy buttons, VoIP steps); Builder 2 test button and status polling ("Calling your business number…", "Forwarding works", "We didn't receive the call — check the code and try again"); Builder 3 setup checklist link (`phone_number` opens this) + tests.

**Carries and rulings:**
- Carrier and VoIP names only in `copy/forwarding.ts` (added to the vendor-name allow-list in this task's copy-rules test update).

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): call-forwarding guide per carrier with a one-click test`
