# F1 decision log (controller ledger from the subagent-driven build of docs/superpowers/plans/2026-10-10-roofline-f1-platform-core.md)

- **Spec:** docs/superpowers/specs/2026-10-10-roofline-foundation-design.md (binding authority)
- **Branch:** f1-platform-core (in the main checkout; branched from main at fd9603e)
- **Owner instruction:** build without approval check-ins. Stop only for push, spend, send, credentials, or destructive actions.

## Setup rulings

- **Ruling: work on branch `f1-platform-core` in the main checkout, not a separate worktree.**
  - Why: Task 1 must relocate untracked local files (`.env`, `data/`, `node_modules/`) that exist only in this checkout.
  - Cost if wrong: switching this checkout back to `main` shows v1 at the root without its `.env` (it now lives in `v1/`). Recoverable with `mv v1/.env .env`.

## Pre-flight scan

### Pairs that share a file or interface

| Tasks | Produces → consumes | Finding |
|---|---|---|
| T3 ↔ T4 | `global-setup` provides `{owner}` (T3), then adds tenant/system (T4) | consistent |
| T3 ↔ T4 | `TENANT_TABLES` (12 tables) used by the RLS SQL | consistent |
| T3 ↔ T18 | `messages.customer_id` | **conflict:** T18 stores inbound texts from unknown senders with `customer_id` null, but T3 doesn't say nullable → Ruling R2 |
| T3 ↔ T9 | seed users ↔ `requireVerifiedEmail` on invites | **gap:** seed users must be verified or the T9 invite tests 403 → Ruling R3 |
| T5 ↔ T6, T8, T13, T17 | `AppDeps` / `makeTestApp` grow by `google`, `queue`, `sms` | consistent (after the plan's self-review fix) |
| T9 ↔ T13 | `can(member, cap)` ↔ `can(ctx, 'approve_'+class)`, where `ctx.role` may be `'system'` | **type gap** → Ruling R4 |
| T10 ↔ T11 | customers repo, then rep scoping added | consistent |
| T11 ↔ T14 | `isolation.test.ts` route table | consistent |
| T12 ↔ T15 | T12 `send_sms_batch.preview` uses `renderBody`, which T15 creates in `@roofline/send-gate` | **conflict:** wrong order, and shared → send-gate → shared is circular → Ruling R1 |
| T12 ↔ T13 | `StepResult`, `service.ts`, `routes/approvals.ts` | consistent |
| T13 ↔ T14, T17 | `runStep(deps, companyId, stepId)`, `InlineQueue.drain(deps)`, `registerStepHandler` | consistent |
| T14 ↔ T17 | worker schedule `dispatch-messages` (wired in T17) | consistent |
| T15 ↔ T17 | `GateRequest`, `SmsAdapter`, `FakeSmsAdapter` (`send-gate/adapter.ts`) | consistent |
| T16 ↔ T18 | `classifyInbound` | consistent |
| T17 ↔ T18 | messages repo | consistent |
| T4 ↔ T14, T17 | `app_system` column whitelist ↔ `companiesWithExpiredDrafts`, `stepsQueuedLongerThan`, `companiesWithDueMessages` | consistent: the needed columns are whitelisted |
| T19 ↔ all | `db/system` import boundary ↔ T6, T7, T9 (`auth/team-store`), T14 (`jobs/scheduler`), T17 (`jobs/scheduler/dispatch-messages`), T18 (`hooks`) | consistent (after the plan's self-review fix) |

### Each task's own text

| Task | Finding |
|---|---|
| T1 | Says "same count as before the move" but never records a baseline → Ruling R5 |
| T2 | consistent |
| T3 | consistent, with R2 and R3 applied |
| T4 | consistent |
| T5 | consistent |
| T6 | consistent |
| T7 | consistent |
| T8 | consistent |
| T9 | consistent |
| T10 | consistent |
| T11 | consistent |
| T12 | R1 |
| T13 | Concurrency: the second approver blocks on `FOR UPDATE`, then sees `running` → 409 "already handled". Consistent with the test, which asserts the status code. |
| T14 | consistent |
| T15 | **conflict:** the FL 3-per-24h deferral test can't trigger at cap ≤ 2, because the 7-day cap blocks first → Ruling R6 |
| T16 | consistent |
| T17 | **conflict 1:** "only customers without a message row" contradicts "`failNext(1)`, then the retry sends it" → Ruling R7. **Conflict 2:** the `c5` time zone is unstated → Ruling R8 |
| T18 | consistent, with R2 applied |
| T19 | consistent |

### Rulings

- **R1 — Ruling: `renderBody` lives in `packages/shared/src/render.ts`, created in T12.** `@roofline/send-gate` imports it from shared; it is not created in T15.
  - Why: removes the circular dependency and the ordering conflict.
  - Cost if wrong: one file location.
- **R2 — Ruling: `messages.customer_id` is nullable** (T3 schema).
  - Why: T18 stores inbound texts from unknown numbers, per spec §3.5 "every other message is stored".
  - Cost if wrong: one nullable column.
- **R3 — Ruling: `seedTwoCompanies` sets `email_verified_at = now()` for every seed user** (T3). Seed companies also get `phone_e164 = +14025550199`.
  - Why: T9 invites need verified users, and the T18 HELP reply needs a company phone.
  - Cost if wrong: test-only.
- **R4 — Ruling: `can()` accepts `role: Role | 'system'` and returns false for every capability when the role is `'system'`.**
  - Why: `TenantContext` includes the system role used by the runner.
  - Cost if wrong: trivial.
- **R5 — Ruling: T1 runs v1's `npm test` before the move, records the pass count in its report, and compares after.**
  - Cost if wrong: none.
- **R6 — Ruling: the T15 FL-deferral test passes `marketingCapPer7d: 5` in the pure `GateRequest`.** The settings API still limits 0–2. With current settings the FL rule is a backstop.
  - Why: the test must exercise the rule, and `decide()` is pure.
  - Cost if wrong: none (test-only).
- **R7 — Ruling: add `messages.retryable boolean not null default false`** (new migration in T17).
  - When the adapter throws, the row becomes `failed` with `retryable = true`, and a retry re-sends it.
  - A stale `queued` row (older than 5 minutes) becomes `failed` with `retryable = false` and is never resent.
  - The handler processes customers that have no row, or a row with `status = 'failed' AND retryable`.
  - Why: the plan's test requires retrying sends the provider definitely rejected. The spec forbids resending when the outcome is unknown.
  - Cost if wrong: one column.
- **R8 — Ruling: in T17, `c5`'s property is `state FL`, `timezone America/New_York`.** It is scheduled for 08:00 America/New_York the next day, and the dispatcher test advances to 08:01 America/New_York.
  - Cost if wrong: test-only.

## Models

- **Implementers:** sonnet by default; opus for T4 (RLS), T13 (approval concurrency) and T17 (send batch + dispatcher); haiku for T2 and T16 (transcription-style).
- **Task reviewers:** sonnet.
- **Final review:** fable (most capable).

## Progress
- Task 1: implementer DONE_WITH_CONCERNS (226744a). Review: spec ✅, quality approved, 1 Important (plan-mandated): dev Postgres published on 0.0.0.0.
  - Ruling: bind to 127.0.0.1:54329:5432. Why: a trivial superuser password is exposed to the LAN, and the spec doesn't require all interfaces. Cost if wrong: none (still host port 54329).
- Task 1: minor (deferred): pg_isready healthcheck should use -h 127.0.0.1 (init-server race with --wait)
- Task 1: minor (deferred): root README run-v1 line omits `cp .env.example .env` and `npm run build`
- Task 1: minor (deferred): eslint `files` covers only *.ts under apps/ and packages/; add ignores for generated drizzle output later
- Task 1: minor (deferred): `platform: linux/amd64` is hard-coded in compose
- Task 1: minor (deferred): .gitignore has a redundant v1/.buildcli/ and an inert !v1/data/.gitkeep
- Task 1: fix round 1/5 (1 addressed, 0 open; commits 226744a..b570e1e)
- Task 1: complete (commits fd9603e..b570e1e, review clean)
- Task 2: R9 — Ruling: `toE164` validates by NANP structure: libphonenumber-js parse with default US, calling code 1, 10-digit national number, NPA and NXX first digit 2-9. It does not rely on `isValid()` metadata. Why: plan fixtures across T2/T10/T17/T18 use fictional 555-01XX numbers, which metadata may reject. Cost if wrong: a few structurally valid but unassigned numbers are accepted; carriers reject them at send time.
- Task 2: complete (commits b570e1e..8355a99, review clean). ⚠️ strict mode resolved: tsconfig.base.json strict:true (confirmed in the Task 1 review).
- Task 2: minor (deferred): the phone ruling isn't pinned by tests (exchange 2-9 rule, +44 rejection, 11-digit rejection, 555 area-code acceptance). Carried into the Task 10 dispatch.
- Task 2: minor (deferred): the phone.ts comment misstates why isValid() is avoided (it is the fictional 555 area code, not 555-01XX)
- Task 2: minor (deferred): toE164 silently drops extensions and surrounding text. Document it as lossy; callers keep the raw input.
- Task 2: minor (deferred): toll-free and Caribbean NANP numbers are accepted (per the ruling); gate rules must handle textability
- Task 2: minor (deferred): redundant trim guard; no enums test (GATE_RULES order unpinned); cosmetic test title
- Task 3: R10 — Ruling: enum columns are `text` typed with drizzle `{enum: [...]}` from @roofline/shared, plus a CHECK constraint per column. Not pgEnum. Why: adding enum values later is a plain migration. Cost if wrong: none.
- Task 3: implementer DONE_WITH_CONCERNS (409593e). Review: spec ✅, Needs fixes, 1 Important (I1: no same-company composite FKs).
  - Ruling: fix now with unique(company_id,id) and composite FKs in a new 0001 migration. Why: the spec isolation promise, and this is cheapest before repos exist. Cost if wrong: slightly more verbose FK definitions.
- Task 3: minor (deferred): M1 messages.purpose nullable for outbound; add CHECK (direction='in' or purpose not null)
- Task 3: minor (deferred): M2 activities.actor_agent should be CHECK-backed AGENTS
- Task 3: minor (deferred): M3 companies.timezone NOT NULL default America/Chicago hides missing values. F3 sign-up must set it from the geocoded address; flagged for the Task 6 dispatch.
- Task 3: minor (deferred): M4 DB-only enum arrays (MESSAGE_PURPOSES, CHANNELS, DIRECTIONS, SMS_CONSENT_SOURCES, USAGE_KINDS) live in packages/db/src/schema/enums.ts. Move them to @roofline/shared when send-gate or the API needs them (carry into the Task 10 and Task 15 dispatches).
- Task 3: minor (deferred): M6 the Task 4 custom migration must use `drizzle-kit generate --custom` (journal `when` ordering); carry into the Task 4 dispatch
- Task 3: minor (deferred): M8 address_key normalization exists only in a comment. Put normalizeAddressKey() in @roofline/shared in Task 11.
- Task 3: minor (deferred): M9 the seed hashPassword duplicates Task 6's. Task 6 adds a test verifying a seeded hash via verifyPassword.
- Task 3: minor (deferred): M10 global-setup doesn't stop the container if migrate throws; M11 updated_at only bumps via drizzle $onUpdate
- Task 3: minor (deferred): CREATE EXTENSION postgis needs a privileged owner on managed Postgres (deploy note)
- Task 3: fix round 1/5 (1 addressed + geometry test add-on, 0 open; commits 409593e..02ccb1e)
- Task 3: complete (commits 8355a99..02ccb1e, review clean)
- Task 4: R11 — Ruling: app_tenant gets DELETE on opt_outs only (Task 18 START removes the opt-out row). No DELETE elsewhere: archive instead. Cost if wrong: a later migration grants more.
- Task 4: R12 — Ruling: test and dev owner connections are superusers, so seeding and tests bypass FORCE RLS. Prod migrations insert no tenant rows. Cost if wrong: a seed script on a non-superuser owner would need set_config.
- Task 4: implementer DONE_WITH_CONCERNS (2401cde); deviation: updated_at added to the companies column UPDATE grant (needed by drizzle $onUpdate)
- Task 4: review (opus): spec ✅, no Critical, Needs fixes: I1 pool 'error' listeners missing (crash on DB restart); I2 plan-mandated: app_tenant can read texting_registrations.subaccount_auth_token_encrypted.
  - Ruling (I2): column-level SELECT for app_tenant on texting_registrations, excluding the token, via a new 0003 migration. Why: least privilege; only app_system needs the token for webhook verification. Cost if wrong: tenant repos must name columns.
  - Ruling (M1): updated_at in the companies column-UPDATE grant is ratified. Why: drizzle $onUpdate needs it, and the worst case is a tenant backdating its own timestamp. Cost if wrong: none.
- Task 4: minor (deferred): M2 pg-boss install likely runs CREATE SCHEMA IF NOT EXISTS, which fails for app_system without database CREATE privilege. Carry into the Task 14 dispatch.
- Task 4: minor (deferred): M3 withTenant doesn't assert a uuid companyId ('' silently gives empty results)
- Task 4: minor (deferred): M4 test gaps: non-uuid setting (22P02), id/created_at not in the denied-columns loop, cross-company test should pin 23503, guard test doesn't assert no pgboss USAGE / public CREATE
- Task 4: minor (deferred): M5 DEPLOY: Supabase default ACLs grant anon/authenticated on new public tables; revoke them or disable the Data API (users.password_hash, sessions are exposed otherwise)
- Task 4: minor (deferred): M6 plaintext password in ALTER ROLE shows in logs; M7 no connectionTimeoutMillis/statement_timeout on pools; M8 stale comment tenant.ts:47
- Task 5 carry: drizzle wraps pg errors in err.cause, so the error mapper must read err.cause.code
- Task 4: fix round 1/5 (2 addressed, 0 open; commits 2401cde..bb7ea42)
- Task 4: complete (commits 02ccb1e..bb7ea42, review clean)
- ENV: iCloud Desktop & Documents sync renamed v1/package.json, v1/package-lock.json and v1/node_modules to "… 2" copies (byte-identical) and left .git/index 2. Restored with mv. Set xattr com.apple.fileprovider.ignore#P on node_modules and v1/node_modules.
  - Ruling: leave .git syncing (it is the only off-machine copy until the owner OKs a GitHub push); check git status after each task. Cost if wrong: possible .git conflict copies; recover from the working tree.
- Task 4 out-of-scope: tenant reads of texting_registrations must name columns (whole-row select is refused). Carry into the Task 15/17 dispatches.
- Task 5: complete (commits bb7ea42..2108855, review clean)
  - Ruling: accept MAIL_FROM (required when POSTMARK_TOKEN is set). Why: Postmark needs a verified sender. Cost if wrong: none.
- Task 5: minor (deferred): 413 only for application/json bodies (other types are never buffered); future raw/text parsers need their own limit
- Task 5: minor (deferred): a throwing logError bypasses the JSON 500; ConsoleMailer logs to/subject (PII) in production
- Task 5: minor (deferred): no .env loading for local dev (tsx --env-file-if-exists); HOST default 127.0.0.1 means deploy must set HOST=0.0.0.0 (deploy note)
- Task 5: minor (deferred): test nits (SentMail dup, PORT 0 in testConfig, last test re-seeds, shared pools close)
- Task 6: R14 — Ruling: the default logError logs only error name, first message line (Drizzle "params:" section stripped) and pg code (err.cause.code). Never SQL params. Done in Task 6 because auth routes put password hashes and token hashes in params. Cost if wrong: less detail in logs.
- Task 6: complete (commits 2108855..e83a053, review clean (opus))
  - Ruling: ratify the Task 6 deviations: the global default-deny /api gate (signed-out unknown /api paths → 401, Task 5 assertions adjusted); attachSession + requireSession split; createSession(now); failures-only login limiter; the 403 for correct password with no active membership; reserved slugs; 200-character name cap. Why: each improves security or is forced by the injected clock. Cost if wrong: the 404-vs-401 behaviour differs from the plan text.
- Task 6: minor (deferred → Task 7): M1 re-login leaves the old session alive; M4 DUMMY_PASSWORD_HASH must derive from COST; M5 email max 254; M9 role/canApproveSpend freshness test; sign-up needs its own limiter (409 email oracle and verification-email flood)
- Task 6: minor (deferred → Task 9): disabling a member should delete that member's sessions
- Task 6: minor (deferred): logout with a dead cookie gives 401 and leaves the cookie; per-session API budget multiplies with bulk sessions (key by user later); compensating delete order and scoping; mixed clocks in sessions.created_at; 403 wording for invited-only; log path inconsistency
- Task 7: implementer DONE_WITH_CONCERNS (382e9f3). Review: spec ✅, Needs fixes, 1 Important: reset-request timing oracle (the known-account transaction and mail start run before the response).
  - Ruling: respond first, then do the work in a detached try/catch task, with a test hook for background work. Cost if wrong: a slightly delayed email.
  - Ruling: ratify issueToken's extra `now` parameter (needed for deps.clock). Task 9 invite tokens use the same signature.
- Task 7: minor (deferred): lock-order inversion between reset-issue (users then tokens) and reset-consume (tokens then users) can deadlock (40P01, 500 on /reset)
- Task 7: minor (deferred): a login that started before a reset can insert a session after the reset's session purge (needs a password-change marker)
- Task 7: minor (deferred): verification tokens are not bound to an email address (matters if email change is added); user_tokens are never purged (scheduler cleanup)
- Task 7: minor (deferred): DEPLOY: TRUST_PROXY must be set behind a proxy or all IP limiters share one bucket; ConsoleMailer includeBody must be false in production (reset links would land in logs)
- Task 7: minor (deferred): no maxmem on hashPassword/dummy scryptSync (COST bump hazard); targeted reset-request lockout is the accepted trade-off
- Task 7: fix round 1/5 (1 addressed, 0 open; commits 382e9f3..b412c3e)
- Task 7: complete (commits e83a053..b412c3e, review clean)
- Task 7: minor (deferred): unbounded detached reset work across many IPs/emails (bounded in-process queue later); background work is lost on shutdown
- Task 8: implementer DONE_WITH_CONCERNS (0aee91f), fixed pre-review on controller rulings:
  - Ruling: when Google links to an UNVERIFIED existing user, clear password_hash, delete all sessions and unused user_tokens, then link and verify. Why: closes account pre-hijacking (attacker signs up with the victim's email first). Cost if wrong: a legit unverified password user must reset after linking.
  - Ruling: JWKS fetch/network failures → logError + 503 "Google sign-in is having trouble right now…"; token verification failures stay 401. Why: an outage shouldn't look like bad credentials. Cost if wrong: none.
  - Ruling: ratify the implementer's 409 for a verified email tied to a different Google sub, the 200 for new Google accounts (not 201), and RS256 + requiredClaims.
- Task 8: review (opus) at 6b585bd: spec ✅, Needs fixes, 2 Important.
  - I1: an in-flight password login survives the Google hand-over (also covers the Task 7 reset race).
    - Ruling: password-login session insert is conditional on password_hash = the verified hash. Cost if wrong: none.
  - I2 (plan-mandated): auto-link trusts email_verified for non-Google-authoritative domains.
    - Ruling: link only for gmail/googlemail or a matching hd; otherwise 409 "This email already has a Roofline account. Please sign in with your password." New-user creation is unchanged. Cost if wrong: Microsoft-365 roofers can't one-click-link Google to an existing password account (they keep the password).
- Task 8: minor (deferred): JoseGoogleVerifier expiry uses the wall clock, not deps.clock; two inaccurate comments in google.ts (jose cache headers; verifier throws 503 too)
- Task 8: minor (deferred): duplicate-create race leaves a half-made account if the winner's settings step fails (sessions.active_company_id has no cascade)
- Task 8: minor (deferred → Task 9): a handed-over account keeps the pre-registrant's company; invites/members/integrations must sit behind requireVerifiedEmail
- Task 8: fix round 1/5 (2 addressed; reviewer found an I1 residual: no row lock in the conditional insert, so an uncommitted hand-over/reset window remains; commits 6b585bd..96f8858)
  - Ruling: reopen the I1 residual as fix round 2 (FOR SHARE on the users select, plus two-connection tests). Why: I1's intent is to close the race completely. Cost if wrong: one extra round.
- Task 8: minor (deferred): signIn reorder can orphan a never-sent session row if deleteSession throws; the 409 "sign in with your password" wording misleads for Google-only accounts on non-authoritative domains
- Task 8: fix round 2/5 (I1 residual addressed with FOR SHARE OF u; commits 96f8858..1296870)
- Task 8: complete (commits b412c3e..1296870, review clean)
- Task 9: R15 — Ruling (invites):
  - A membership row is created only on acceptance (status active). Pending invites live in `invites` and are listed in GET /api/team as `invites`.
  - Re-inviting the same email replaces the pending invite (old token invalid).
  - Accept: a new email creates a user (token proves inbox control, so verified). An existing user needs a live session as that user, the correct password, or a Google sub equal to users.google_sub.
  - Expired or used → 400; already a member → 409.
  - Disabling a member deletes their sessions whose active_company_id is this company.
  - Cost if wrong: invite UX tweaks later.
- Task 9: implementer DONE_WITH_CONCERNS (54db5f8).
  - Ruling (pre-review): add can_approve_spend to the company_members view (migration 0004, appended column) and to GET /api/team members. Why: the owner must see delegation state in the team UI. Cost if wrong: none.
  - Ruling: ratify GET /api/company readable by all members; invites list for company_admin only; a role change resets canApproveSpend unless set; accepting as a disabled member reactivates with spend off; light website/state/zip validation; serviceArea not editable.
- Task 9: review (opus) at 5016b93: spec ✅, no Critical, Needs fixes: I1 accept-invite session made outside the txn and unconditional (reopens the Task 8 race).
  - Ruling: write the session inside the acceptance txn; a session-proof switch failure → 401.
  - Ruling: promote Minor 2 (a disabled member can reactivate via a pending invite) to fix round 1: disable voids pending invites for that email; consistent lock order. Why: it bypasses the owner's disable decision. Cost if wrong: none.
  - Ruling: ratify 400 (not 401) for an existing user whose Google email differs from the invite.
- Task 9: minor (deferred): mixed demote+disable race untested; invite mail abuse (one address gets the whole 30/h budget; company name echoed in mail); separate accept-invite failure budget
- Task 9: minor (deferred): audit atomicity edges (tenant audit commits before the system commit); duplicate UUID regex (move to validate.ts); GET /api/company/settings can insert defaults (use ON CONFLICT DO NOTHING or drop)
- Task 9: fix round 1/5 (2 addressed, 0 open; commits 5016b93..652ea40)
- Task 9: complete (commits 1296870..652ea40, review clean)
- Task 9: minor (deferred): test asserts missing on the deleted-proof case; overclaiming test title; a no-op disable PATCH voids a legitimate re-invite (not audited)
- Task 9 out-of-scope (→ final review): user_tokens lock order is inconsistent in auth.ts (reset: tokens→users; issue and hand-over: users→tokens), so a 40P01 deadlock is possible. Same as the Task 7 minor. Also PATCH /api/company uses FOR UPDATE on companies (FOR NO KEY UPDATE suffices).
- Task 10: R16 — Rulings:
  - Duplicate-phone check serialized with pg_advisory_xact_lock per (company, e164).
  - Consent changes restricted to owner/office; 'attested' is import-only.
  - Clearing do_not_contact does not delete opt_outs (the safe direction).
  - Reps in Task 10 see only customers they created; Task 11 widens to job-linked.
  - Move the DB-only enums (SMS_CONSENT_SOURCES etc.) to @roofline/shared.
  - Pin the Task 2 phone ruling with 4 extra tests.
- Task 10: implementer DONE_WITH_CONCERNS (c30fe39).
  - Ruling: ratify opt_outs ON CONFLICT DO NOTHING (keeps the original STOP keyword and date). Ratify: a manual consent restore leaves opt_outs (texting stays blocked until START/Task 18); a rep sending doNotContact gets 403; the company-wide duplicate-phone 409 visible to reps. Cost if wrong: an owner may be confused that restoring consent doesn't re-enable texting.
- Task 10: complete (commits 652ea40..c30fe39, review clean)
  - Ruling: ratify the WriteOptions {now, ip} 4th argument on the customer repo writes, and the extra activity kinds/summaries (DNC on/off, customer.unarchived).
- Task 10: minor (deferred → Task 11): consent-role rule lives only in the route (add a repo guard); ensure opt_outs whenever the customer is opted out and consent/phones are touched
- Task 10: minor (deferred): a second consentNote is silently dropped on an existing 'written'; stale evidence carries to a later consent; same-instant activity order is arbitrary; unarchive 409 names an unsent field; PATCH/unarchive races untested
- Task 11: R17 — Rulings:
  - normalizeAddressKey() in @roofline/shared; duplicate → 409 "This address is already saved."
  - assignedUserId must be an active company member (400 "Pick someone on your team."); reps may only assign themselves (403 otherwise).
  - FK violations map to 400 field errors. A property tied to a different customer → 400 "That address belongs to a different customer."
  - Reps see valueCents only on jobs assigned to or created by them (omitted on unassigned leads).
- Task 11: implementer DONE_WITH_CONCERNS (cfafeb2). Pre-review rulings:
  - Reps must give customerId when creating a property. Why: no creator column, so a rep would create an address they can't see. Cost if wrong: one extra field for reps.
  - PATCH property.customerId is refused when the address has jobs for a different customer.
  - The duplicate-address 409 carries field addressLine.
  - Leaving 'lost' clears lost_reason.
  - Ratified: activities route stays 404 for unopenable subjects; the Task 10 test changed for the widened scope.
  - Ruling: ratify the rep PATCH customerId:null → 400; clearing an address's customer to null allowed even with jobs; the lost-reason clear is unconditional when leaving lost.
- Task 11: review (opus) at 14717da: spec ✅, no Critical, 1 Important (plan-mandated): the customer timeline "New job: <street>" leaks an address the rep can't open (address with no customer).
  - Ruling: a job claims an unowned address for its customer (same txn, locked, activity + audit). Why: the address belongs to the homeowner, and this removes the leak. Cost if wrong: an owner can't keep a customer-less address with jobs.
- Task 11: minor (deferred): the 3a race (checkLinks reads the address without FOR SHARE); restoring an archived job skips the consistency check; a rep can reveal or overwrite an open lead's value via self-assign; broad rep write power over the open-lead pool (design question for the owner); archived unassigned leads keep their customer/address visible to reps
- Task 11: minor (deferred): a job created outside 'lost' can carry a lostReason; unrequested job move via PATCH (no timeline line on the new customer); address key merges "12-14" and "1214"; yearBuilt uses the UTC year; job audit rows hold valueCents (a future audit viewer must hide them from reps); duplicated id/includeArchived helpers
  - Ruling: ratify the implementer's addition: PATCH property customerId:null is refused when the address has any job (supersedes the earlier 'clear to null allowed'). Why: keeps the invariant that an address with a job always has a customer. Cost if wrong: an owner must archive jobs' addresses differently.
- Task 11: fix round 1/5 (1 addressed, 0 open; commits 14717da..ad49609)
- Task 11: complete (commits c30fe39..ad49609, review clean)
- Task 11 out-of-scope (→ final review): claimAddress locks only on the unowned path (TOCTOU with a concurrent clear); a customer reassign ignores archived jobs while a clear counts them (leak shape via the archived job's timeline line); legacy mixed data can claim an address for another customer
- Task 12: R18 — Rulings:
  - renderBody in @roofline/shared (R1).
  - send_sms_batch customerIds must all exist in the company (400 "Some of these customers don't exist.").
  - Editing or toggling a step requires the approve capability for that step's class.
  - createTask is an internal service only (no HTTP create).
- Task 12: implementer DONE_WITH_CONCERNS (4713b63).
  - Ruling (pre-review): StepView payload is included in GET /api/approvals/:taskId and in the PATCH response (not the list). Why: the F2 editor needs it to prefill. Cost if wrong: none.
  - Ruling: ratify 409 on edits past expires_at; expired:true only for draft/expired; toggle-only edits skip re-validation (the gate content rule is the backstop); detail visible to owner/office for any status; AppError.latest + changedWhileLooking + the task.create audit.
- Task 13 carry: on approve, re-validate each enabled step's payload (company name may have changed); reuse AppError.latest for 409s.
  - Ruling: ratify payload in the 409 latest StepView (same editor refresh).
- Task 12: complete (commits ad49609..3987cc2, review clean)
- Task 12: minor (deferred): hard-coded send_sms_batch customer check in service (registry could declare it); StepView.preview/type loosely typed; step.edit audit stores the full payload on toggle-only (~400 KB for 5k ids); no length/NUL checks on createTask title/kind/summary; the approvals list has no pagination; duplicate canReview guard; dedupePrefix trimmed to 1–100 chars (tell Tasks 14/17)
- Task 13: R19 — Rulings:
  - approve refuses expired drafts via isExpired (409 "This plan expired before it was approved. You can run it again.").
  - approve re-validates enabled pending steps (400 on steps.<id>.payload, nothing approved).
  - GET /api/approvals count excludes expired tasks.
  - retry needs the capability for the step's class.
  - The tasks feed and summary are for owner/office; reps get [] and working 0.
  - server.ts uses an in-process ImmediateQueue until Task 14 swaps in pg-boss.
- Task 13: implementer DONE_WITH_CONCERNS (90f86b1).
  - Ruling: ratify no-op approve → 409 "already handled"; refreshTask moves back to running/awaiting_owner and never overwrites declined; retry keeps awaiting_owner; the claim commits in its own txn; a 6th claim marks needs_attention without running.
  - Ruling (pre-review): TaskView.minutesSaved and StepView errorPlain/attempts/result (counts only) added to list+detail; give-ups logged via logError in R14 format. Why: F2 retry/hours-saved UI and operability. Cost if wrong: none.
- Task 13: minor (deferred): ImmediateQueue doesn't retry (replaced by pg-boss in Task 14)
- Task 13: review (opus) at 0bccc34: spec ✅, Needs fixes.
  - I1: the runner holds FOR UPDATE on the step across the handler, and handler writes roll back on a throw. Task 17 would double-text on retry, or deadlock if it committed progress separately.
  - I2: a dead running step is never recovered.
  - I3: retry overrides declined.
  - I4: the single-execution guard is untested.
  - Ruling (plan defect, fixed in Task 13): new runner protocol.
    - Claim only from queued, with lease_expires_at = now+10m (new column). Handler runs with no lock and commits its own progress.
    - Finish is conditional on attempts=n. The parked outcome (running) clears the lease. A throw with n<5 → back to queued then rethrow.
    - reclaimExpiredLeases() for the Task 14 sweeper. Retry accepts running with an expired lease. Any remaining lock is FOR NO KEY UPDATE.
    - Why: makes outbound handlers safe (no double-send, no deadlock) and recoverable. Cost if wrong: a rework of the runner contract; Tasks 14/17 depend on it.
  - Ruling: retry on a declined task → 409 "This was already handled."
- PLAN AMENDMENT (Task 14): the sweeper also calls reclaimExpiredLeases per company and enqueues the returned ids. Parked steps (NULL lease) are never reclaimed.
- PLAN AMENDMENT (Task 17): sendSmsBatch must commit each recipient's message row in its own short withTenant (queued before sms.send, then sent/failed after). Never hold one transaction across the batch; no customer data in thrown errors.
- Task 13: fix round 1 implementer DONE (987bdb7).
  - Ruling: ratify reclaimExpiredLeases(tx, ctx, now) taking ctx; finishing a run locks task→step (avoids a retry/stale-finish deadlock); the requeue errorPlain "This step hit a problem. We'll try it again shortly."
- PLAN AMENDMENT (Task 14): app_system needs column SELECT on agent_task_steps.lease_expires_at (and status) for the sweeper fan-out. (Task 17): handlers longer than 10 minutes need per-item idempotency (already planned); no lease renewal.
- Task 13: fix round 1/5 (4 addressed, 0 open; commits 0bccc34..987bdb7)
- Task 13: complete (commits 3987cc2..987bdb7, review clean)
- Task 13: minor (deferred → Task 14): M1 the run fence is reset by retry (attempts→0), so a stale >10-minute run can hit a newer run. Add a monotonic run_seq fence in Task 14.
- Task 13: minor (deferred): M2 a stale n=5 throw logs a misleading "gave up"; M3 if end() throws, the handler's cause isn't logged; F2 retry button should key on status, not errorPlain
- Task 14: R20 — Rulings:
  - Monotonic run_seq fence: claim bumps it, finish/requeue fence on it, retry never resets it, attempts still drives the 5-rule.
  - The sweeper reclaims expired leases per company with FOR UPDATE SKIP LOCKED.
  - app_system gets column SELECT on agent_task_steps(lease_expires_at, run_seq).
  - pg-boss: migration GRANTs CREATE ON DATABASE to app_system (pg-boss runs CREATE SCHEMA IF NOT EXISTS).
  - The API sends via PgBossQueue; the worker processes. Parked steps are never reclaimed.
- Task 14: implementer DONE_WITH_CONCERNS (e129e1b). pg-boss 12.37.1 (named export PgBoss, createQueue before send/schedule, policy 'short' for singletonKey, array job handlers).
  - Ruling (pre-review): drop GRANT CREATE ON DATABASE from 0006 (createSchema:false works; least privilege); add a rerun guard via agent_tasks.rerun_of_task_id with a unique index (second rerun → 409 "This plan was already run again.").
  - Ruling: apps/api/src/scripts/** may import @roofline/db/system (carry into the Task 19 lint rule).
  - Ruling: ratify no FK on rerun_of_task_id (the FK lock would clash with the rerun's FOR UPDATE; the unique index backstops it). DEPLOY note: run set-role-passwords on fresh DBs.
- Task 14: complete (commits 987bdb7..c703651, review clean (opus))
  - Ruling: ratify FOR NO KEY UPDATE SKIP LOCKED in reclaimExpiredLeases (instead of FOR UPDATE). Why: keeps step rows on NO KEY locks (Task 13 rule) and still skips rows held by other sweepers or finishes. Cost if wrong: none.
- Task 14: minor (deferred → Task 19): seed-demo needs a production guard (refuse NODE_ENV=production without --allow-production); ensureStepQueue should verify the existing queue policy is 'short'
- Task 14: minor (deferred → Task 17): worker schedule cleanup can flap during rolling deploys once dispatch-messages is added
- Task 14: minor (deferred): rerun re-enables switched-off steps (product question for F2); TaskView lacks rerunOfTaskId; the resent count includes dropped duplicates; no automated in-flight shutdown test; a stale n=5 throw logs "gave up"
- Task 15: implementer DONE (97a0a2e). The stray scratchpad copies were untracked and removed; verified git status is clean with no tracked deletions.
- Task 17 carry: decide() throws on an invalid now or when no valid IANA zone exists → treat as a failed message (retryable=false) with plain reason "We couldn't work out this customer's local time."; compute dedupeAlreadySent from dedupeKey; the dispatcher re-runs decide() (covers cap re-check)
- Task 15: complete (commits c703651..97a0a2e, review clean (opus); 511-combination rule-order probe and a ~1.28M-point zone sweep, 0 defects)
  - Ruling: ratify decide() throwing on an invalid now / no valid zone (company-wide, programmer or config error). Task 17 catches per recipient and per company.
- Task 15: minor (deferred → Task 16, same package):
  - M1 isTimeZone accepts fixed offsets (reject /^[+-]/ or use the Intl list)
  - M2 Invalid Dates in history under-count the cap (fail closed)
  - M3 non-boolean optedOut/dedupeAlreadySent fail open (use strict checks)
  - M5 blank informational body → block content
  - M6 add a decide() fallback test (tz null + state null at 21:30)
- Task 15: minor (deferred): the "(daily limit)" reason shows even when quiet hours bind equally (brief-mandated); the shared barrel re-export pulls zod/libphonenumber at runtime
- Task 16: R21 — fold the Task 15 M1/M2/M3/M5/M6 hardening into Task 16 (model sonnet instead of haiku). Blank informational reason: "This message is empty."
- Task 16: implementer DONE (e784d60, 1380861).
  - Ruling: ratify the M1 extension (isTimeZone accepts slash names that resolve via Intl.DateTimeFormat to a listed zone, e.g. America/Indiana/Indianapolis, Asia/Kolkata; offsets still rejected); M2 maps an invalid Date to now; the M6 test is coverage-only.
- FINAL-REVIEW MUST-FIX: API timezone validation (apps/api validate.ts, used by company + property) uses Intl.supportedValuesOf ∪ UTC only. It REJECTS real US zones (America/Indiana/Indianapolis, America/Kentucky/Louisville, US/Central), so Indiana/Kentucky roofers can't save their zone. Unify into one shared isTimeZone (in @roofline/shared) used by the API and send-gate; consider canonicalizing on save.
- Task 18 carry: add "stop all" (with a space) to the STOP list in classifyInbound (CTIA variants; the opt-out direction is the safe one)
- Task 16: complete (commits 97a0a2e..1380861, review clean)
  - Ruling: ratify no length cap on classifyInbound (a padded STOP still opts out).
- Task 18 carry (R22, opt-out breadth; TCPA "any reasonable means"):
  - NFKC-normalize before stripping.
  - Collapse repeated identical tokens ("STOP STOP").
  - Add stop phrases: stop all, stop please, stop texting me please, please stop texting, please stop messaging me, unsubscribe please, unsubscribe me please, please remove me, remove me from the list, take me off the list, take me off of your list, dont text me again, do not contact me, dont contact me, dont message me, quit texting me, stop it, stop sending, no more texts.
  - START only when no digits were stripped.
  - Inbound 'other' messages containing a stop-like word (stop|unsubscribe|remove me|opt out) create a "possible opt-out, please check" activity for owner review.
  - Zero-width-only bodies count as blank in decide().
- Task 17: R23 — Rulings:
  - Per-recipient commits (the PLAN AMENDMENT): insert queued with ON CONFLICT (step_id, customer_id) DO NOTHING; only the inserter sends; then update sent/failed.
  - messages.retryable migration (R7); c5 in America/New_York (R8).
  - A decide() throw → failed, retryable=false, "We couldn't work out this customer's local time."
  - Production sms adapter = DisabledSmsAdapter (F3 adds Twilio; the registration rule blocks real companies anyway).
  - The dispatcher wraps each company in try/catch.
  - A parked step completes via a conditional UPDATE WHERE running AND lease IS NULL.
  - Tenant reads of texting_registrations name columns.
- Task 17: implementer DONE_WITH_CONCERNS (a1bb18b).
  - Ruling: ratify staleness from updated_at; dedupe/cap counting in-flight queued rows under a per-customer advisory lock; a dispatch-time provider refusal → step failed ("Some texts didn't go out. You can retry them.") and task partly_done; the dispatcher visits companies with parked steps and finishes only when no scheduled/queued rows remain; buildGateRequest returns null for an out-of-company customer; recipient state from properties.state. Why: each is fail-closed or prevents stuck steps.
- Task 17: review (opus) at a1bb18b: no Critical; Needs fixes.
  - I1: handler outcome ignores DB retryableFailed (an approved text can be silently lost under overlapping runs).
  - I2: the gate uses an archived property's home.
  - I3 (plan-mandated): every provider throw is treated as not-sent (double-send risk on timeouts).
  - Ruling: throw on refused || DB retryableFailed; non-archived properties only; SmsRefusedError = definite refusal (retryable), any other error = unknown (failed, retryable=false, never resent); FakeSmsAdapter.failUnknownNext; DisabledSmsAdapter throws SmsRefusedError.
  - Ruling: promote archived customers → block contact "This customer is archived."; per-parked-step try/catch in the dispatcher.
- Task 17: minor (deferred → F3): the 10-minute lease vs 5,000-recipient batches needs a lease heartbeat or chunking before Twilio
- Task 17: minor (deferred): the dispatcher's `tried` NOT IN list grows quadratically; step-less queued rows are never cleaned; the result refresh can briefly regress; any decide() throw is labelled "local time"; STOP in the ms window between the isOptedOut read and the queued commit (Task 18's STOP writer should take lockRecipient); stale check uses ≤; a type cast hides drift; company facts are read per customer
- Task 18 carry: the inbound STOP writer takes lockRecipient(company, customer/phone) so a STOP serializes with in-flight sends
- Task 17: fix round 1/5 (5 addressed, 0 open; commits a1bb18b..52501a8)
- Task 17: complete (commits 1380861..52501a8, review clean (opus))
- Task 17 out-of-scope (→ final review): a step that gave up (needs_attention/failed) still has its scheduled rows dispatched and its result isn't updated; the row wording after a lost lease says "We'll try again" when only a person can retry; consider a brand check alongside instanceof SmsRefusedError for F3's bundled adapter
- Task 18: R24 — Rulings:
  - Add messages.from_e164 (migration). Inbound stores From there and the company number in to_e164.
  - STOP: opt_out upsert, revoke consent for ALL customers with that phone under lockRecipient, audit + activity.
  - START: delete all opt_out rows for the phone; consent → express where revoked; DNC customers stay DNC; reply still sent (carrier compliance).
  - other with a stop-like word → "Possible opt-out — please check" activity.
  - TwiML XML-escaped.
  - Status callbacks never downgrade delivered; ignore queued/sent; dedupe by MessageSid+MessageStatus.
  - No signing token → 403.
  - urlencoded limit 64kb.
  - R22 classifier breadth (NFKC, repeated tokens, phrase list, START without stripped digits).
- Task 18: implementer DONE (a62c7d3, b3875e4).
  - Ruling: ratify the Kelvin/U+0130 pre-pass and STOP matching on either the plain or NFKC reading; strict START (fullwidth START → other; the conservative direction); signingTokenFor(…, encryptionKey) 4th argument; global webhook dedupe keys.
- Task 18: minor (deferred → F3): a delivered status that arrives before the SID is saved is lost (the text stays sent)
- Task 18: review (opus) at b3875e4: no Critical; Needs fixes.
  - I1: re-split MessageSid replay defeats dedupe (a replayed START undoes a STOP).
  - I2 (plan-mandated): polite/alternate opt-outs neither matched nor flagged.
  - Ruling: strict SID /^(SM|MM)[0-9a-f]{32}$/ and E.164 checks (400 otherwise); polite prefix/suffix stripping for the STOP lookup only; a widened looksLikeOptOut flag (incl. quit/end/revoke/cancel + stems), with company-level flags for unknown senders.
  - Ruling: promote M3 (consent lock before the opt_outs upsert), M5 (companyId-prefixed dedupe keys), M9 (strip XML-forbidden control characters).
- Task 18: minor (deferred → F3): the claim isn't atomic with the work (use a unique inbound sid index + ON CONFLICT); 404 vs 403 reveals active numbers (accepted); no rate limit on hooks; the HELP fallback lacks contact info when the company has no phone; inactive numbers drop STOPs/delivery reports; reconcile with Twilio's own opt-out handling; twilio ^6.1.2 is very new
  - Ruling: ratify migration 0009 adding the 'message' activity subject type (needed for company-level flags); noisier flag accepted; /status checks the SID only.
- Task 18: fix round 1/5 (5 addressed, 0 open; commits b3875e4..7e3783f)
- Task 18: complete (commits 52501a8..7e3783f, review clean (opus))
- Task 18: minor (deferred): stale doc comments (activities "customer, property or job"); unknown-sender flags aren't listable until an inbox exists (F2/Front Desk); non-E.164 senders (short codes) are dropped with 400 (F3 note)
- Task 19: R25 — fold in the carried items:
  - the lint allowlist includes apps/api/src/scripts/**
  - seed-demo production guard (--allow-production)
  - ensureStepQueue verifies the 'short' policy
  - FINAL-REVIEW MUST-FIX timezone unification: one isTimeZone in @roofline/shared used by API validate.ts and send-gate (accepts real aliases like America/Indiana/Indianapolis, rejects offsets)
  - fix the stale doc comments
- Task 19: implementer DONE (faa733d..4a94675). Ruling: ratify the shared isTimeZone accepting miscased names (luxon resolves them; harmless) and the extra relative-path lint patterns.
- Task 19: complete (commits 7e3783f..4a94675, review clean)
- Task 19: minor (deferred): the relative-path lint pattern misses sibling-package paths (../../db/src/system); dynamic import() isn't caught; lint covers only *.ts (F2 .tsx needs it); the **/test/** exemption could cover a future src/x/test; CI double-runs on PR branches and cancel-in-progress can cancel main; the checklist labels the STOP/HELP/START wording row with the classifier test; v1 `npm start` not smoke-tested; a non-UUID app.company_id setting is untested (fail-closed cast error); small code nits
- FINAL REVIEW (fable) at 4a94675: no Critical; With fixes.
  - I1: tsx is a devDependency (prod npm ci omits it); HOST defaults to 127.0.0.1; no env docs.
  - I2: migration 0002 sets BYPASSRLS, which needs a superuser (Supabase has none).
  - I3 (plan defect): a property's timezone copies the company's at creation and never follows later changes → quiet-hours violation once texting is on.
  - I4 (→ F3 must): the inbound claim isn't atomic with the work (a lost STOP on crash).
  - I5 (→ F2): a gave-up batch step's scheduled rows still send and its result goes stale.
  - Ruling: fix I1–I3 now in ONE fix dispatch:
    - I1: tsx in dependencies; HOST 0.0.0.0 in production; README env table + .env.example.
    - I2: edit unreleased 0002 to create app_system NOBYPASSRLS, plus permissive FOR ALL TO app_system policies on the RLS tables it is granted on (cost if wrong: the dev compose DB must be recreated).
    - I3: properties.timezone stays NULL unless the client gives one, so the gate falls back to the live company zone.
  - Ruling: I4 and the lease heartbeat are F3-go-live blockers; I5 goes to F2.
- Final fix wave: implementer fixed I1–I3, focused GREEN, but uncommitted and the full run was unfinished; resumed to finish the run and commit.
  - Ruling: ratify the I2 deviations: roles created LOGIN NOBYPASSRLS with BYPASSRLS stripped only if present; the owner temporarily grants itself app_system (format('%I', current_user), avoiding the PG17 segfault) for CREATE SCHEMA pgboss AUTHORIZATION, then revokes.
- F2/F3 notes from the final fix: extensions in the Supabase `extensions` schema make app_system citext lookups case-sensitive (install into public); PG15 untested; PATCH property timezone:null can't clear a zone.
- FINAL fix wave: 1/1 (I1–I3 addressed, re-review clean; commit 4a94675..66638a8)
