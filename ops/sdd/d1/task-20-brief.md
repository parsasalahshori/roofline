### Task 20: Web skeleton

**Base:** `d1-front-desk` after Task 3 is merged. **[C1]** `router.tsx`, `shell/apps.ts` (`shipped: boolean`), `Settings.tsx`/`tabs.ts`; Real (F2): `shell/Shell.tsx` (`badgeFor`, the `counts` record has `'front-desk': 0`), `copy/dock.ts`.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Files (addition, Ruling DH):** Modify `apps/web/src/shell/Shell.tsx` (Front Desk badge count only), `apps/web/src/copy/dock.ts` (`frontDeskBadge`).

**Split:** Builder 1 routes (`/front-desk`, `/front-desk/:conversationId`), dock flag (`front_desk` shipped, no "Coming soon"); Builder 2 placeholders and `api.ts`, Settings slots (`FrontDeskTab` for owner/office; `TransferPhone` under "Your profile" for everyone); Builder 3 copy files (`front-desk`, `forwarding` — carrier and VoIP names allowed in `forwarding.ts`), `test/d1-routes.test.tsx`.

**Tests:**
- routes render placeholders; dock opens `/front-desk`; Settings tab visibility by role.

**Carries and rulings:**
- **Ruling DH:** this task edits `shell/Shell.tsx` once: `'front-desk'` count from `useFrontDeskUnread()` (a placeholder in `features/front-desk/api.ts` returning 0) and a `dock.frontDeskBadge(count)` branch in `badgeFor`; T26 fills the hook. No other D1 task edits `Shell.tsx`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): routes and slots for Front Desk`
