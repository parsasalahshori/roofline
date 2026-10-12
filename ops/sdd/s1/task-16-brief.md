### Task 16: Ad accounts — linking Google and Meta

**Base:** `s1-storm` after Task 7 is merged. Real (F3 T4/T16, **[C1]** T12, **[E1]** T8): `shared/setup.ts` (`SetupFacts` already has `calendarsConnected`, `pricesAndTiersSaved`), `repos/setup.ts` `setupFacts`; `connect_ads` is in `SETUP_ITEM_KEYS` with `comingWith 'storm_scout'`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `routes/ads.ts` + `storm/ad-accounts.ts` (connect Google: validate 10-digit id, `invite`, row pending; check: `linkStatus`/`accountInfo`; Meta: `verifyAccess`); Builder 2 `repos/ad-accounts.ts` + `connect_ads` in `shared/setup.ts`/`repos/setup.ts` (done when one account is active); Builder 3 the recheck of pending accounts folded into `ad-spend-sync`'s hourly fan-out (plus on demand through `/check`) and tests.

**Interfaces:** `POST /api/ads/accounts/google { customerId: '123-456-7890' | '1234567890' }` → 201 `{ account, instructions: { managerId } }`; `POST /api/ads/accounts/meta { adAccountId: 'act_…' | digits }` → 201 `{ account }` (status active or pending with `reason`); `POST /api/ads/accounts/:id/check`; `DELETE` → status `revoked` (Google: the manager link is ended too); owner only for all (office can view).

**Tests:**
- with the fakes, Google pending → accept → active and `connect_ads` done; Meta not shared → pending with reason → share → active; revoke; office 403 on writes; a second Google account replaces the first only after revoking.

**Carries and rulings:**
- E1 T8 and C1 T12 already edited `shared/setup.ts`/`repos/setup.ts`; this task is S1's only editor.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): link the roofer's Google Ads and Meta ad accounts`
