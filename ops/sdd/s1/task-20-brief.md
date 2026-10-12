### Task 20: Storm landing page and requests

**Base:** `s1-storm` after Tasks 7 and 9 are merged. Real (F3): `public/policies.ts` (company host from `<slug>.<POLICY_PAGES_DOMAIN>`; server-rendered HTML pattern). **[E1]** `publicRateLimit()` and the `/api/public` prefix (E1 T5). **[C1]** `createJob` (C1 T6).

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `public/storm-page.ts` (server-rendered HTML like F3's policy pages: company name and phone, storm line, form, consent checkbox unchecked with the exact text stored, `noindex`, no third-party scripts, ≤ 30 KB) + `system/storm-page-lookup.ts`; Builder 2 `public/storm-requests.ts` + `storm/landing.ts` (zod; honeypot; per-IP and per-page limits; one per phone per page; address geocoded; creates customer/property/Lead job with `storm_id` and source `web`, consent `express`/`web_form` with evidence when ticked, activity, Today follow-up); Builder 3 `repos/storm-pages.ts` (page created with the plan's first ad step or on first request for the link; `code` 8 chars base32; `active_until` = storm day + 30) and tests.

**Interfaces:** `GET https://<slug>.<POLICY_PAGES_DOMAIN>/storm/<code>` → 200 HTML or 404 page; `POST /api/public/storm-requests/:code { name, phone, address, okToText, website }` (website = honeypot) → 201 `{ ok: true }` / 422 `{ error, field }`; the form posts with plain HTML (no JS needed) and redirects to a thank-you state.

**Tests:**
- the page shows only that company; an inactive code → 404; honeypot filled → 201 without records; duplicate phone → 201 without a second job; consent recorded only when ticked; rate limits; phone width check is in e2e.

**Carries and rulings:**
- Public routes: no session, no third-party scripts, `noindex`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): storm landing page that turns ad clicks into storm leads`
