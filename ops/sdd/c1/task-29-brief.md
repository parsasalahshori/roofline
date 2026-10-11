### Task 29: Manual smoke: real Google and Outlook calendars

**Base:** `c1-crm` after Tasks 10–14 are merged. Pattern: F3 **Task 37**'s smoke scripts (`assertConfirmed(argv, flag)`; reuse it from F3's smoke helper module, or copy the 5-line function if T37 is not merged). From T10/T11: `GoogleCalendarApi`, `MicrosoftCalendarApi`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `apps/api/src/scripts/smoke/calendar.ts`; Builder 2 `docs/superpowers/c1-manual-smoke.md`; Builder 3 the guard test.

**Files:**
- Create: `apps/api/src/scripts/smoke/calendar.ts`, `docs/superpowers/c1-manual-smoke.md`, `apps/api/test/smoke-calendar-guards.test.ts`
- Modify: `apps/api/package.json` (`"smoke:calendar": "tsx src/scripts/smoke/calendar.ts"` only)

**Interfaces:**
- `smoke:calendar --provider google|microsoft --confirm-real-calendar` (refuses without the flag, reusing F3 T37's `assertConfirmed` pattern with this flag): prints an auth URL, reads the pasted code, creates a test event "Roofline smoke — delete me" tomorrow 10:00–11:00, waits for Enter while the operator moves it in the real calendar, runs `syncEvents` and prints what moved, then deletes the event. Never prints tokens.
- **Runbook:** for each provider: connect through the app on staging with a real account, book/move/cancel an appointment and see it in the real calendar within a minute; move and delete it in the real calendar and see the app follow within 5 minutes; an outside event appears as "Busy"; revoke access in the account's security settings and see "Reconnect your calendar". A sign-off table at the end.

**Carries and rulings:**
- Never run `smoke:*` in automation; the guard test only checks the refusal.

**Verify notes:**
- typecheck, lint; the guard test on CI. **Never run `smoke:*` in automation.**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `test(smoke): real Google and Outlook calendar run, by hand only`
