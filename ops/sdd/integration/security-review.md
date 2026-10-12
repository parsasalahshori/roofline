# Security review: launch-integration

**Probe:** `origin/launch-integration` at `a7e2b559` ("ops(integration): pass 12 merges and findings").
**Date:** 2026-10-12.
**Mode:** read-only review. Nothing in this review changes code; the controller routes the fixes.

**Method:**
- Four reviewers worked in parallel:
  - unauthenticated routes, webhooks and OAuth;
  - tenant isolation for migrations 0010–0024;
  - app_system and app_hail grants, plus cross-site and CSRF protection;
  - secrets and PII in logs, rate limits, and secrets in the repo.
- The C1 lead re-checked every finding below against the code at that sha.
- Finding 2 was reproduced in headless Chromium 1194. A page served with `Referrer-Policy: no-referrer` that submits a form sends `Origin: null`; the same page with `same-origin` sends the real origin.
- No test suites were run, because this box has no Docker.

**Severity scale:**
- **High:** cross-tenant money or data, or a core public flow broken in real browsers.
- **Medium:** abuse or compliance risk that needs work before launch.
- **Low:** defence in depth, hygiene or ops.

**Owners** are named by track: F2/F3 platform, C1 CRM and calendar, E1 estimator and proposals, S1 storm and ads, D1 front desk, A1/G1 agents.

## Not in this tree

The `/relay` WebSocket and the Twilio voice webhooks do not exist at this sha:
- nothing imports `ws`;
- `system/relay-tokens.ts`, `voice-routing.ts`, `fd-retention.ts` and `line-lookups.ts` are `export {};` stubs.

They need their own review when D1 lands them. In particular, `calls.call_sid` is globally unique (0019:42), so a voice route must only ever take `call_sid` from a Twilio-signed request.

## Findings

| # | Sev | Owner | Finding | Where |
|---|---|---|---|---|
| 1 | High | S1 | One company can link and spend from another company's ad account, and can unlink it | `0017_storm_schema.sql:62`; `storm/ad-accounts.ts:80-111,147-170,214-221`; `providers/google-ads/link.ts:76` |
| 2 | High | S1 (pages), F2/F3 (helmet) | The storm landing form and the unsubscribe confirm form are refused with 403 in real browsers | `app.ts:235` (helmet default `no-referrer`); `public/unsubscribe.ts:104,151`; `public/storm-page-html.ts:77`; `public/storm-requests.ts:51-66`; `app.ts:219-228` |
| 3 | Medium | S1 | Anyone can record "express" SMS consent for any phone number through the storm form, and fill a page's hourly budget | `public/storm-requests.ts:51-56`; `storm/landing.ts:82,186-199`; `repos/storm-requests.ts:203-278` |
| 4 | Medium | F2/F3 | `TRUST_PROXY` defaults to 0 and is not checked at startup, so behind Render's proxy every IP limit is shared by all visitors | `config.ts:171`; `.env.example:161`; `app.ts:234` |
| 5 | Medium | F2 | Login is limited only per IP and email: password spraying, distributed guessing, and scrypt-pool exhaustion are possible | `rate-limit.ts:84-97`; `auth/routes.ts:353`; `auth/password.ts:9` |
| 6 | Medium | D1 | app_system can read every company's transcript text and tool calls; nothing uses the grant, and a test pins it | `0020_front_desk_grants_rls.sql:82,84,100`; `packages/db/test/rls.test.ts:1525-1554` |
| 7 | Low | F3 | The Twilio registration hook runs up to ~1,800 database lookups before the signature check | `hooks/twilio-registration.ts:43-66`; `/hooks/*` has no rate limit (`app.ts:253-262`) |
| 8 | Low | E1 | The IP hashes on proposal events are unkeyed and reversible | `public/proposal-common.ts:85-87`; `repos/proposal-public.ts:369` |
| 9 | Low | F2/F3, E1, S1 | `GRANT ALL` (including TRUNCATE, TRIGGER and REFERENCES) to app_system on global tables | `0002_roles_rls.sql:80-83`; `0016:103`; `0018:43`; `rls.test.ts:592-595` |
| 10 | Low | S1, F3 | app_system and app_hail hold grants nothing uses, or wider than needed | `0018:29` (app_hail UPDATE), `0018:169` (company_storms), `0018:188` (email_opt_outs.email), `0011:59` (usage_events) |
| 11 | Low | F2 | Session cookie: no `__Host-` prefix, and `Secure` only when `NODE_ENV=production` | `auth/sessions.ts:14,151` |
| 12 | Low | F2 | Errors raised after headers are sent reach Express's default logger unscrubbed | `errors.ts:146-149`; reached from `routes/export.ts:83-101` and `public/proposals.ts:86-96` |
| 13 | Low | F2/F3 | Postmark rejection text, which contains recipient emails, is logged | `mailer.ts:38-42` |
| 14 | Low | S1, F2 | Unsubscribe tokens (which carry the email) are logged in the path on a 500 | `public/unsubscribe.ts:155,169`; `errors.ts:125-127` |
| 15 | Low | F2 | Invite emails can be sent at scale from sign-up companies | `rate-limit.ts:197-213`; `routes/team.ts:94-136` |
| 16 | Low | F2 | Sign-up reveals whether an email has an account | `auth/routes.ts:337-340` |
| 17 | Low | F2 | `.gitignore` covers only `.env`, not `.env.local` or `.env.production`, in a public repo | `.gitignore:3` |
| 18 | Low | F2, S1, F3 | Public routes with no rate limit | `public/storm-page.ts`, policy pages, `/u/:token`, `/hooks/twilio*`, `/hooks/postmark` |
| 19 | Low | F2 (ops) | Limiter counters are per process; limits multiply when scaled out | `rate-limit.ts:9-13` |
| 20 | Low | C1, S1, D1, A1, G1, E1 | User-id columns reference `users(id)`, not a member of the same company | 0013, 0017, 0019, 0021, 0023 (columns listed below) |
| 21 | Low | F3 | A raw `pools.system` query outside `@roofline/db/system` | `account/texting/progress.ts:187` |
| 22 | Low | C1, E1 | Eight tenant tables have no behavioural cross-company test | `packages/db/test/rls.test.ts` |
| 23 | Note | S1 | app_hail cannot read tenant data, but it controls the storms every tenant is matched against | `services/hail/hail/writer.py`; storm-match fan-out |

### 1. High (S1): ad accounts are shared across companies

**The gap:**
- `ad_accounts` is unique only on `(company_id, platform)`.
- `assertNotLinked` checks only the caller's own company.
- Roofline has one Google manager account (MCC) and one Meta business for all tenants.

**Attack path:**
1. Company B links Google Ads customer X, and the MCC link is ACTIVE.
2. Company A, any new sign-up whose owner is the attacker, posts X to `POST /api/ads/accounts/google`. Customer IDs are not secret.
3. `invite(X)` returns early because the link is active.
4. `evaluateAdAccount` sees `linkStatus === 'active'`, so A's row is stored `active` with B's name and currency.
5. A's storm campaigns are then created in B's account (`ad-campaign.ts` uses `account.externalAccountId`). That spends B's money and shows A B's stats.
6. A's `DELETE /api/ads/accounts/:id` calls `adsGoogle.unlink(X)`. That cuts Roofline off from B's account, which disables B's 95% spend guard for B's live campaigns.
7. If B's link is still pending, A turns active as soon as B accepts.
8. Meta behaves the same way through `verifyAccess`, because Roofline's business user has access.

**Fix:**
- Add a global partial unique index `(platform, external_account_id) WHERE status <> 'revoked'`. app_tenant can't see other companies' rows, so the index (or an app_system lookup) must raise the conflict.
- Refuse a connect when the platform link already exists and the account isn't this company's.
- Only `unlink` when no other non-revoked row references the account.

### 2. High (S1, F2/F3): `Referrer-Policy: no-referrer` turns both public forms' Origin into `null`

**The cause:**
- `helmet()` sets `Referrer-Policy: no-referrer` on every response by default, and `unsubscribe.ts:151` sets it again.
- Under the Fetch spec, a non-CORS POST (an HTML form submission) from such a document sends `Origin: null`. I confirmed this in Chromium.

**Unsubscribe:**
- The confirm form posts to `/u/:token`, and `blockCrossSiteMutations` (mounted before `/u`) refuses `"null" !== APP_ORIGIN`.
- A homeowner clicking "Unsubscribe" gets a JSON 403. Only the providers' one-click POST, which has no Origin, works. This is a CAN-SPAM and compliance risk.

**Storm landing form:**
- `stormRequestOriginGuard` requires the company host as Origin, so `null` gets a JSON 403 before `browserFormErrors` runs.
- The lead form does not work from a real browser.

**Why tests miss it:**
- `unsubscribe.test.ts` and `storm-requests.test.ts` post with no Origin or with an explicit one, never `null`.
- No e2e spec submits either form.

**Fix:**
- Serve these two pages with `Referrer-Policy: same-origin` (or `strict-origin-when-cross-origin`). Do not loosen the guards to accept `null`.
- Add a test that posts with `Origin: null` and asserts it is refused, which documents the dependency.
- Add an e2e spec that submits each form in a browser.

### 3. Medium (S1): unverified SMS consent through the storm form

**The gap:**
- A script with no Origin passes `stormRequestOriginGuard`. The page code is public: it appears on the page, in alert emails and in ads.
- With `okToText`, any phone number gets `express` consent with source `web_form`, with audit and evidence rows.
  - A new phone becomes a new customer.
  - An existing customer at `none` is upgraded (`upgradeConsent`).
- The phone is never verified.
- Each new fabricated number also creates a customer and a Lead job.
- About 10 IPs (5 per IP per hour) use up the 50-per-page-per-hour budget, so real homeowners get 429 for the rest of the hour.
- No automatic send reads `storm_requests` today. The harm is a false consent record that later texting relies on.

**Fix:**
- Don't upgrade an existing customer's consent from an anonymous form. Record the request and leave consent for the owner to confirm, or require a verified reply ("YES") before `express`.
- Consider a per-phone cap and a CAPTCHA-free proof of work or similar.
- Decide the per-page budget with finding 4 in mind.

### 4. Medium (F2/F3): `TRUST_PROXY` default

**The gap:**
- With 0 behind Render's proxy, `req.ip` is the proxy for everyone. All IP-keyed limits then become global:
  - storm form, 5 per hour (`landing-copy.ts:22`);
  - signup, 10 per hour;
  - login, reset, accept-invite, `/api/public`, and the unauthenticated `/api` bucket.
- A value above the real hop count lets clients choose their IP through `X-Forwarded-For`.
- `docs/superpowers/f1-decision-log.md:161` deferred it.

**Fix:**
- Document the exact Render hop count.
- Refuse to start in production with 0.

### 5. Medium (F2): login rate limit is keyed by IP and email only

**The gap:**
- One IP can try 10 passwords per email across any number of emails. It is capped only by the general 600-per-minute per-IP bucket.
- Many IPs (IPv6 is grouped by /56) can guess one account with no per-account cap.
- Each attempt costs a scrypt (N=16384) on the 4-thread pool, including the dummy hash. A few IPs can slow every login, signup and reset.

**Fix:**
- Add a per-email cap across all IPs, with a soft lock.
- Add a lower per-IP cap across all emails.

### 6. Medium (D1): app_system reads transcript text

**The gap:**
- `GRANT SELECT (id, company_id, text, tool_calls, at) ON conversation_turns TO app_system`, with `app_system_all USING (true)`. Nothing reads it: `fd-retention.ts` is a stub.
- Blanking text (`SET text = ''`) needs only UPDATE plus SELECT on the WHERE columns.
- app_system is the pool behind every unauthenticated route. Any SQL injection or logic bug there would read every company's call transcripts, which contain caller PII.

**Fix:**
- Drop SELECT on `text`.
- Keep `tool_calls` SELECT only if the planned "reduce to names" sweep needs it.
- Update `rls.test.ts:1525-1554`.

### 7–23. Low and notes

7. **Twilio registration hook (F3).**
   - `textingSidsIn` collects every sid-shaped string in a 64 KB body (~1,800), and each one runs a `companyIdForTextingSid` query before any signature check.
   - Load only, no data exposed. Fix: try at most a few sids.
8. **Proposal IP hash (E1).** `sha256(ip + companyId)` can be brute-forced over the 2^32 IPv4 space. Use a keyed HMAC like `storm/landing.ts` `ipHashFor`. Note that `proposal_signatures.ip` already stores the raw IP on signing.
9. **`GRANT ALL` to app_system (F2/F3 0002, E1 0016, S1 0018).**
   - TRIGGER plus ownership of the `pgboss` schema would let an attacker with app_system SQL plant a trigger function. That function then runs as app_tenant or the migration owner.
   - TRUNCATE bypasses RLS.
   - Fix: replace ALL with the privileges used.
10. **Unused or wide grants.**
    - app_hail UPDATE on `hail_runs` and `storm_contours` is never used (S1).
    - app_system SELECT on `company_storms.storm_id`, `plan_task_id` and `last_matched_at` is unused (S1).
    - `email_opt_outs.email` SELECT exposes every company's opt-out list. It is needed only for `ON CONFLICT (company_id, email)`; plain `ON CONFLICT DO NOTHING` plus `RETURNING id` would drop it (S1).
    - `usage_events.id` and `kind` are unused (F3).
11. **Session cookie (F2).** Use `__Host-rl_session` with `Secure` always behind https. This guards against cookie tossing from a same-site company host, and staging over https sending the cookie without `Secure`.
12. **Late errors (F2).** When headers are already sent, `next(err)` reaches Express's `logerror`, which prints the full error and `cause` (Drizzle params, pg detail). Call `logError(err, pathForLog(req.path))` first.
13. **Postmark text (F2/F3).** Errors 406 and 300 echo recipient addresses into the logged error, from signed-PDF, alert and auth mail. Log only `ErrorCode`.
14. **Unsubscribe path (S1, F2).** `pathForLog` scrubs only `/public/proposals/`. Extend it to `/u/`.
15. **Invite spam (F2).** 10 sign-ups per hour per IP × 30 invites per company per hour gives about 300 emails an hour, with an attacker-chosen company name, from Roofline's domain. Add a per-user or per-IP cap across companies, and a new-account allowance.
16. **Enumeration (F2).** Sign-up answers 409 for an existing email; login, reset and Google don't reveal this. Accepted risk or an email-first flow.
17. **`.gitignore` (F2).** Use `.env*` with `!.env.example` and `!apps/web/.env.development`.
18. **Unlimited public routes.** These are DoS or oracle concerns only; nothing is forgeable:
    - `GET /storm/:code` and the policy pages (one DB lookup each);
    - `/u/:token`;
    - `/hooks/twilio*` (company lookup, token decrypt and HMAC before the signature fails; 404 versus 403 reveals company numbers);
    - `/hooks/postmark`.
19. **Per-process counters (ops).** Move limiter state to a shared store before running more than one API instance.
20. **User-id columns.** These reference `users(id)` rather than a member of the same company. The app checks membership where it matters (`routes/appointments.ts:170`, `storm/routes-build.ts:85`, `routes/calendar-connect.ts:163`), so this is defence in depth only. Columns:
    - `appointments.assigned_user_id`, `calendar_connections.user_id`, `calendar_busy_blocks.user_id`, `member_schedules.user_id` (0013);
    - `door_routes.user_id`, `door_stops.outcome_by` (0017);
    - `calls.transfer_user_id`, `blocked_numbers.blocked_by` (0019);
    - `agent_settings.paused_by`, `agent_task_events.actor_user_id`, `time_recounts.by_user_id` (0021);
    - `claim_events.by_user_id` (0023);
    - E1's `created_by_user_id` columns.
21. **Raw system pool (F3).** `progress.ts:187` uses `deps.pools.system.select(...)` outside `@roofline/db/system`. It filters by the caller's company, so nothing leaks; it breaks the convention only.
22. **Missing behavioural isolation tests.** The structural RLS test covers all 56 TENANT_TABLES. These tables have no cross-company read/write test:
    - C1: `calendar_event_links`, `calendar_busy_blocks`, `member_schedules`, `pricebooks`, `quote_counters`;
    - E1: `proposal_counters`, `proposal_events`, `exact_report_orders`.
23. **Hail integrity (S1).** Forged `storms` or `storm_contours` rows feed every tenant's matching, alerts and plans. This is inherent to the design; keep the hail credentials isolated.

## Checked and sound

**Tenant isolation**
- All 41 tenant tables added in 0013–0024 match the 0002/0011 pattern:
  - RLS enabled and forced;
  - `tenant_isolation` on `company_id = nullif(current_setting('app.company_id', true), '')::uuid` in both USING and WITH CHECK;
  - listed in TENANT_TABLES and in the structural test;
  - composite same-company foreign keys, including the cross-track ones.
- There are no SECURITY DEFINER functions.
- Repos take only `Tx`, and the only way to get one is `withTenant`.

**Roles**
- app_system and app_hail are not superusers and have no BYPASSRLS or CREATE.
- app_system cannot read OAuth or integration credentials, `link_token_encrypted` or ad tokens. The texting subaccount token is the one secret it reads, and it needs it.
- app_hail has no path to tenant data.

**Proposal links**
- Tokens are 256 bits, and only the hash is stored and looked up.
- Access is scoped to the token's company and proposal.
- Expiry and replace answer 410. Signing happens under row locks, and the server builds the signed-document hash.
- Responses are no-store, no-referrer and noindex, with per-token limits.

**Storm landing page**
- All values are escaped, and `?error=` keys come from an allow-list.
- The page has no scripts and uses CSP.
- Codes are 40 bits and bound to the host's slug and to `activeUntil`.
- There is no open redirect.

**Unsubscribe**
- Tokens are HMAC with an HKDF key and compared with `timingSafeEqual`.
- GET has no side effect.

**Webhooks**
- Twilio: signature over `PUBLIC_BASE_URL + originalUrl` with the routed company's key, MessageSid dedup, and `bodySHA256` required for JSON.
- Stripe: raw body, a 300-second tolerance, a timing-safe compare, replay claims, and event-time ordering.
- Postmark: constant-time Basic auth before the body is read.

**OAuth and cross-site**
- Calendar OAuth: the state is HMAC-signed, lives 10 minutes, is single-use, and is bound to company, user and provider. Redirects go to fixed targets, and read-only companies are refused.
- There is no ad-account OAuth callback.
- `blockCrossSiteMutations` refuses `null`, look-alike hosts and the wrong scheme or port, and runs before body parsing.
- There is no CORS. The session cookie is SameSite=Lax and HttpOnly.
- The JSON parser accepts only `application/json`.
- No GET under the session mutates state, apart from the signed OAuth callback.

**Logging**
- `describeErrorForLog` keeps the first line and pg code only, with no params, stack or cause.
- `reportJobError` and its roughly 40 callers go through it.
- There is no request logger.
- Every provider error maps to a fixed sentence.
- Config errors name variables, never values.
- Smoke output is redacted.
- The hail service drops error text.

**Repository**
- There are no live keys or real numbers or emails in source, fixtures or docs.
- The `.env.example` files hold placeholders, and no `.env` has ever been committed.
