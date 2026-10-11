### Task 19: Web: homeowner page and e-sign

**Base:** `e1-estimator` after Tasks 4 and 14 are merged. From T4: `PublicProposalView`, `CONSENT_TEXT_V1`, `ESTIMATE_CLAUSE_V1`. From T14: the public `/p/:token` route outside `RequireSession` and the shell.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `HomeownerPage.tsx` (layout, option cards, inclusions, financing line, "Most popular", contact links, expired/declined/signed states); Builder 2 `SignFlow.tsx` (consent checkbox, typed name, optional `SignaturePad.tsx` canvas with pointer and touch, clear, "Sign and accept $14,250", keyboard-only path) and `DeclineSheet.tsx`; Builder 3 `copy/homeowner.ts` (with `CONSENT_TEXT_V1`/`ESTIMATE_CLAUSE_V1` equality test), `features/homeowner/api.ts` (fetch without credentials to `/api/public/proposals/:token`), tests.
- **Rules:** phone-first (375×812 first), 16px inputs to avoid iOS zoom, no third-party scripts, `<meta name="robots" content="noindex">` set via the route, the page never shows unit prices.

**Tests:**
- renders the three options; financing line; sign with keyboard only posts the exact body; the drawn signature path posts a PNG; already-signed and expired states; decline with reason; view event posted once per load.

**Carries and rulings:**
- Files: `apps/web/src/features/homeowner/{HomeownerPage,SignFlow,SignaturePad,DeclineSheet}.tsx`, `features/homeowner/api.ts`, `copy/homeowner.ts`; test `apps/web/test/homeowner.test.tsx`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): the homeowner's proposal page with electronic signing`
