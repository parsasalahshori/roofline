### Task 17: Web: proposal view and editing

**Base:** `e1-estimator` after Tasks 3 and 14 are merged. From T3: `priceTier`. From T4: `ProposalView`.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `OptionCard.tsx` (editable while draft: on/off, name, material, waste, markup, add-ons list editor; live price via `priceTier`); Builder 2 `ProposalWindow.tsx` (status, events, message preview, Send, Copy link, Download PDF, Make revised); Builder 3 `copy/proposals.ts`, `features/proposals/api.ts`, tests.

**Tests:**
- live totals equal `priceTier`; editing PATCHes; a sent proposal is read-only with "Make a revised proposal"; events line "Opened 3 times · last today 7:12 PM"; copy link writes the clipboard (mocked) and toasts.

**Carries and rulings:**
- Files: `apps/web/src/features/proposals/{ProposalWindow,OptionCard}.tsx`, `features/proposals/api.ts`, `copy/proposals.ts`; test `apps/web/test/proposals.test.tsx`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): proposal view with three editable options`
