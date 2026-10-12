### Task R8 (Ruling BF, security review finding 1 High + 9/10 Low): ad accounts are one company's only; S1 grants trimmed

**Base:** `s1-storm` 83e9856. Source: `ops/sdd/integration/security-review.md` on `origin/sec-review` (read findings 1, 9, 10). API and db.

**Fixes:**
1. **(High) An external ad account belongs to one company.**
   - Add a global partial unique index `ad_accounts_platform_external_live_uq` on `(platform, external_account_id) WHERE status <> 'revoked'` (use the real revoked status name from `AD_ACCOUNT_STATUSES`). Ruling AW: put it in the drizzle schema (`uniqueIndex(...).on(...).where(sql\`...\`)`), amend the unreleased `0018_storm_grants_rls.sql` in place and update `meta/0018_snapshot.json`, so drizzle-kit generate reports no changes. The index sees every company's rows, regardless of RLS.
   - Connect (`apps/api/src/storm/ad-accounts.ts`, Google `providers/google-ads/link.ts`, and Meta): claim the row first (insert `pending` inside `withTenant`), and only then call the platform's invite, link or verify. A unique violation (23505 on that index) becomes a 409 with a fixed copy sentence, for example "That ad account is already connected to another Roofline company." The platform is not called, and nothing of the other company (name, currency, status) is returned or stored.
   - Unlink (`DELETE /api/ads/accounts/:id`): call the platform `unlink` only when this company's row was the live (non-revoked) holder. With the index there is then no other live row. If the check needs another company's rows, use a narrow `@roofline/db/system` function that returns a boolean and needs no new wide grant.
   - Tests:
     - Company A tries to connect B's Google customer X, and then B's Meta account. Each is a 409; fake-provider calls are 0; B's row is unchanged.
     - A's delete never unlinks X while B holds it.
     - After B revokes, A can connect.
     - A db test of the index across two companies.
2. **(Low 9/10) Grants in 0018 (Ruling AW, amend in place):**
   - Replace `GRANT ALL ... TO app_system` with the privileges actually used.
   - Drop app_hail UPDATE on `hail_runs` and `storm_contours` if `services/hail` never updates them. Check `writer.py`: if it does update one, keep exactly that grant and note why.
   - Drop app_system SELECT on `company_storms.storm_id`, `plan_task_id` and `last_matched_at` if unused. Grep `@roofline/db/system` first.
   - Drop app_system SELECT on `email_opt_outs.email`: change that system insert to `ON CONFLICT DO NOTHING` plus `RETURNING id`, or whatever no longer reads the column.
   - Update `packages/db/test/rls.test.ts` pins to match.

**Do not touch:** storm-requests or landing (R10), unsubscribe.ts pages or headers (R9), F2/F3/E1 migrations.
**Verify:** typecheck, lint, drizzle-kit no changes. ci-check `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(storm): an ad account links to one company only; S1 role grants trimmed (Ruling BF)`
