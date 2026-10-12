# Task R10 report: storm form consent waits for a verified YES (Ruling BF)

## Built
- packages/db: `storm-requests.ts` no longer writes consent from the public form; the ticked box is recorded on the request as the ask plus the consent text, the customer stays at none. New `confirmFormConsentByYes` promotes consent when the phone replies YES. Per-IP and per-phone caps. Tests in `packages/db/test/storm-requests.test.ts`.
- apps/api: `landing.ts` / `landing-copy.ts` (form copy: reply YES to confirm, no automatic text); `replies.ts` adds `onStormFormYes`; `hooks/twilio.ts` calls it in the `other` case before `onStormReply`. Tests: `storm-requests.test.ts`, new `storm-form-yes.test.ts`.
- docs: `s1-acceptance.md` row updated.

## Review rounds
- Rounds 1-3: each reported one finding (F1) on verify; contact checks amended then approved it. Outcome: fixed (amended in round 1, approved in rounds 2 and 3).

## Minors
- No schema change; `drizzle-kit generate` reports no changes.

## Verify tail
- `tsc -b apps/api packages/db`: clean. `npm run typecheck` shows one error, `apps/web/vite.config.ts` cannot find `@vitejs/plugin-react` (not installed on this machine, file untouched by R10).
- `npm run lint`: clean. `vitest --project @roofline/shared`: pass. drizzle-kit: "No schema changes, nothing to migrate".
- Database-backed suites run on CI via ci-check (no Docker locally).
