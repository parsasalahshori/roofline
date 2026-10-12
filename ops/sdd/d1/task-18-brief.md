### Task 18: Conversations, settings and stats API

**Base:** `d1-front-desk` after Tasks 6, 13 and 14 are merged. Real: `jobScope`/`customerScope`, `requireCapability`, the send gate path for staff replies.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `routes/conversations.ts` (list with filters and cursor; detail with turns (`text` hidden when not stored), tool action cards, links; reply (gate) — sets `team_until = now + 2 h`; handling switch; read); Builder 2 `routes/front-desk.ts` settings (zod, owner/office; facts ≤ 2,000 chars; enabling checks forwarding) + `PUT /api/me/transfer-phone` (E.164, `ackRecording` required) + voices list; Builder 3 stats (`GET /api/front-desk/stats?week=`: answered, booked, transferred, messages, spam, p50 first reply ms, guard blocks, AI minutes vs plan) + tests.

**Files:** Fill the listed files and `packages/db/src/repos/front-desk-settings.ts`; Test `apps/api/test/front-desk/routes.test.ts`.

**Tests:**
- rep sees only conversations of their customers (and unknown-number conversations only if they're on-call); recordings links per role; reply goes through the gate and silences the AI; settings validation; stats from seeded turns; cross-tenant 404 on every route.

**Carries and rulings:**
- Reps see only conversations of their customers (plus unknown numbers when on-call).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): conversations inbox, Front Desk settings and weekly stats`
