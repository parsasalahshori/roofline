### Task 7: API skeleton — seams, fakes, config, jobs, schedules, mounts

**Base:** `s1-storm` after Tasks 1 and 6 are merged. Real (F3): `config.ts`, `deps.ts`, `providers/geocoder.ts` (`Geocoder { configured; geocode(address) }`) + `geocodio.ts` + `fakes/geocoder.ts`, `jobs/{queue,handlers,worker}.ts`, `tasks/handlers.ts` (`builtInHandlers`), `public/policies.ts` (`policyPages(deps)` serves `<slug>.<POLICY_PAGES_DOMAIN>`), `auth/middleware.ts` (`isPublicRoute`). **[E1]** E1 T5 added `/api/public` + `publicRateLimit()`, `ObjectStore`/`createObjectStore`, `FakeFootprintSource` and its job names; **[C1]** C1 T5 added `calendar-push`/`calendar-pull`. Append after them.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 config, deps, test helpers, env docs; Builder 2 the five seams and fakes + `storm-fakes.test.ts`; Builder 3 job names, schedules, step handler stubs, route stubs and mounts, public routes on the company host.

**Files:**
- Create: `apps/api/src/providers/{ads-google,ads-meta,broadcast,ad-image}.ts`, `apps/api/src/providers/fakes/{ads-google,ads-meta,broadcast,ad-image}.ts`, stubs `providers/google-ads/index.ts` (`googleAdsFor(config): AdsGoogle | null` → null), `providers/meta/index.ts` (`metaAdsFor` → null), `providers/postmark-broadcast.ts` (`postmarkBroadcastFor` → null), `providers/resvg-card.ts` (`resvgCardFor` → a stub throwing), all `apps/api/src/storm/*.ts` stubs, `apps/api/src/routes/{storms,door-routes,storm-settings,ads}.ts`, `apps/api/src/public/{storm-page,storm-requests,unsubscribe}.ts`, `apps/api/src/jobs/scheduler/{spotter-sync,storm-match,ad-spend-sync,hail-health}.ts`, `apps/api/test/storm-fakes.test.ts`
- Modify: `apps/api/src/{config,deps,app,index}.ts`, `apps/api/src/providers/{geocoder,geocodio}.ts` + `fakes/geocoder.ts` (`reverseMany`), `apps/api/src/auth/middleware.ts` (public paths `/u/`), `apps/api/src/jobs/{queue,handlers,worker}.ts`, `apps/api/src/tasks/handlers.ts` (register `send_email_batch`, `build_routes`, `create_ad_campaign` stubs that throw "not yet"), `apps/api/src/web.ts` (company-host routes `/storm/:code` beside F3's policy pages), `apps/api/test/helpers.ts`, `.env.example`, `README.md`

**Interfaces:**
```ts
// providers/ads-google.ts
export type Circle = { lat: number; lng: number; radiusM: number };
export type AdCreate = { accountId: string; nameTag: string; dailyBudgetCents: number; startDate: string; endDate: string; circles: Circle[];
  landingUrl: string; headline: string; description: string; companyName: string; city: string; keywords: string[] };
export type AdStats = { spendCents: number; impressions: number; clicks: number; status: 'paused' | 'active' | 'ended' | 'removed' };
export class AdPlatformError extends Error { constructor(readonly kind: AdErrorKind, readonly status?: number) }
export interface AdsGoogle { readonly configured: boolean; managerId: string;
  invite(customerId: string): Promise<void>; linkStatus(customerId: string): Promise<'pending' | 'active' | 'refused' | 'none'>;
  accountInfo(customerId: string): Promise<{ name: string; currency: string }>;
  findCampaign(customerId: string, nameTag: string): Promise<string | null>;
  createCampaign(c: AdCreate): Promise<{ campaignId: string }>;        // created PAUSED
  setStatus(customerId: string, campaignId: string, s: 'active' | 'paused'): Promise<void>;
  stats(customerId: string, campaignId: string): Promise<AdStats> }
// providers/ads-meta.ts
export type MetaCreate = Omit<AdCreate, 'keywords'> & { primaryText: string; imagePng: Uint8Array; housing: boolean };
export interface AdsMeta { readonly configured: boolean; businessId: string;
  verifyAccess(adAccountId: string): Promise<{ ok: true; name: string; currency: string } | { ok: false; reason: 'not_shared' | 'not_assigned' | 'disabled' }>;
  findCampaign(adAccountId: string, nameTag: string): Promise<string | null>;
  createCampaign(c: MetaCreate): Promise<{ campaignId: string }>;      // created PAUSED; throws AdPlatformError('targeting') when Meta requires Housing
  setStatus(adAccountId: string, campaignId: string, s: 'active' | 'paused'): Promise<void>;
  stats(adAccountId: string, campaignId: string): Promise<AdStats> }
// providers/broadcast.ts
export type BroadcastMail = { to: string; from: string; replyTo: string | null; subject: string; text: string; html: string; unsubscribeUrl: string; tag: string };
export interface BroadcastMailer { readonly configured: boolean; send(m: BroadcastMail): Promise<{ messageId: string }> }   // List-Unsubscribe + List-Unsubscribe-Post headers
// providers/ad-image.ts
export interface AdImageRenderer { card(i: { companyName: string; line: string; colorHex: string }): Promise<Uint8Array> }   // 1080×1080 PNG
// providers/geocoder.ts gains
reverseMany(points: { lat: number; lng: number }[]): Promise<({ street: string; city: string; state: string; zip: string } | null)[]>   // Geocodio batch reverse (POST /v1.7/reverse, ≤ 1000 per call, chunks)
```
- **Fakes:** `FakeAdsGoogle` (invite → `linkStatus` pending until `accept(customerId)`; campaigns `g-<n>` stored with their inputs; `stats` from `setSpend(id, cents)`; `failNext(kind)`), `FakeAdsMeta` (`share(adAccountId)` makes `verifyAccess` ok; `requireHousingNext()` makes the next non-housing create throw `targeting`; `m-<n>`), `FakeBroadcastMailer` (records `sent`), `FakeAdImageRenderer` (returns an 8-byte PNG signature), `FakeGeocoder.reverseMany` (`<n> Fake St`, null for points with lat < 0). Each records `calls`.
- **Config:** `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_MANAGER_ID`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN` (all or none), `GOOGLE_ADS_API_VERSION` (default `v21`, Ruling 7); `META_APP_ID`, `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN`, `META_BUSINESS_ID` (all or none), `META_GRAPH_VERSION` (default `v24.0`, Ruling 7); `POSTMARK_BROADCAST_STREAM` (default `broadcast`), `STORM_MAIL_FROM` (email; default `storms@` + the mail domain); `HAIL_STALE_MINUTES` (default 90).
- **`AppDeps` gains** `adsGoogle`, `adsMeta`, `broadcast`, `adImage`; `TestApp` gains the fakes.
- **Jobs:** `JOB_NAMES` gains `'storm-match-company'` (`{ companyId }`, singletonKey companyId), `'storm-draft'` (`{ companyId, companyStormId }`), `'storm-alert'` (`{ companyId, companyStormId, kind: 'now' | 'plan' }`), `'ad-sync-company'` (`{ companyId }`).
- **Schedules:** `spotter-sync` `*/30 * * * *`, `storm-match` `*/10 * * * *`, `ad-spend-sync` `0 * * * *`, `hail-health` `*/15 * * * *`.
- **Mounts:** `/api/storms`, `/api/routes`, `/api/storm/settings`, `/api/ads`; public `/api/public/storm-requests` (the E1 public prefix and `publicRateLimit`); `/u/:token` on the app host (GET page, POST one-click).

**Tests:**
- config groups; fakes' documented behaviour; `/api/public/storm-requests/x` reachable without a session (404 stub); `/u/x` without a session; `SCHEDULES` and `JOB_NAMES` gain the names; the three step stubs registered.

**Carries and rulings:**
- This task owns `app.ts`, `config.ts`, `deps.ts`, `jobs/*`, `tasks/handlers.ts` stubs, `auth/middleware.ts`, `test/helpers.ts`, env docs for S1 (plan Ruling 2). Company-host routes go beside F3's `policyPages`; the plan's `web.ts` mention means that mount.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): S1 skeleton — ads, broadcast email and reverse-geocode seams with fakes; storm jobs and public routes`
