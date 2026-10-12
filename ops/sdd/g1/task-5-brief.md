### Task 5: `send_personal_texts` handler

**Base:** `g1-agents` after Task 3 is merged. Real (F3): `messaging/send-batch.ts` lease pattern, gate path; **[S1]** the per-customer render input (Ruling SA).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

Lease loop (first statement `if (!(await lease.keep())) return { status: 'running', result: {} };`), guard re-check, gate per message, `follow_up_log` row per sent text, result `{ sent, blocked: {rule: n}, scheduled }`; tests.

**Carries and rulings:**
- The lease check stays the first statement in the per-customer loop.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): personal texts step — one gated text per customer`
