### Task 13: Postmark broadcast adapter and unsubscribe

**Base:** `s1-storm` after Task 7 is merged. Real (F3): `hooks/twilio.ts` (signature-check and mount pattern before the session gate), `config.ts` (`SESSION_SECRET`, Postmark keys), `app.ts` hook mounts.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `providers/postmark-broadcast.ts` (`POST /email` with `MessageStream`, headers, recorded responses); Builder 2 `public/unsubscribe.ts` (GET page in S1 styling without the shell, POST one-click) + `system/unsubscribe-lookup.ts`; Builder 3 Postmark bounce/complaint webhook → `email_opt_outs` (`complaint`) in `hooks/postmark.ts` (new, signature by basic-auth secret `POSTMARK_WEBHOOK_SECRET`), tests.

**Files:** Fill the listed files; Create `apps/api/src/hooks/postmark.ts`; Modify `apps/api/src/app.ts` (mount `/hooks/postmark` — allowed here, Ruling 2 exception), `config.ts` (`POSTMARK_WEBHOOK_SECRET`) — **Ruling 2: Task 13 is the only post-skeleton edit to `app.ts`/`config.ts`**.

**Tests:**
- headers `List-Unsubscribe: <https://…/u/…>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; a forged token → 404 page; a valid token records `link`/`one_click` once and shows the company's name; complaint webhook records; wrong secret → 401.

**Carries and rulings:**
- **Plan Ruling 2 exception:** this task adds the `/hooks/postmark` mount in `app.ts` and `POSTMARK_WEBHOOK_SECRET` in `config.ts`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Postmark broadcast stream, one-click unsubscribe and complaints`
