# Task 13 report: Postmark broadcast adapter, unsubscribe, bounce hooks

## Built
- P1 postmark-adapter: apps/api/src/providers/postmark-broadcast.ts (PostmarkBroadcastMailer, postmarkBroadcastFor), 7 tests. Non-2xx throws a status-only message; provider text is never read or stored.
- P2 unsubscribe: packages/db/src/system/unsubscribe-lookup.ts, apps/api/src/public/unsubscribe.ts (GET page, form POST, one-click POST), unsubscribe-token.ts, unsubscribe-key.ts; tests in apps/api/test/unsubscribe.test.ts and packages/db/test/unsubscribe-lookup.test.ts. recordEmailOptOut uses raw SQL naming only company_id, email, source (drizzle's insert lists default columns app_system has no grant on), so 0018 is unchanged.
- P3 postmark-webhook: apps/api/src/hooks/postmark.ts, POSTMARK_WEBHOOK_SECRET in config.ts, mount in app.ts, README and .env.example rows; tests postmark-hooks.test.ts and storm-config.test.ts.

## Decision
The app has no SESSION_SECRET (brief assumed one). Unsubscribe tokens are keyed by unsubscribeKey(config), an HKDF (info 'unsubscribe') of ENCRYPTION_KEY. Task 12 must sign with the same helper.

## Reviews
- Round 1: verify passed, 0 findings.

## Minors
- P2 and P3 were written before running tests (no Docker locally); CI is the check.

## Verify
typecheck clean, lint clean, @roofline/shared 28 files / 657 tests passed.

## CI round 1 (run 38206876310, failed, 2 tests)
- storm-skeleton.test.ts `GET /u/x`: expected the T7 stub's JSON body; the real page answers an html 404. Fixed the assertion (status 404, type text/html).
- postmark-hooks.test.ts auth case: `send(body, undefined)` hit the default parameter and sent the valid secret. Fixed with `null` for no header.
