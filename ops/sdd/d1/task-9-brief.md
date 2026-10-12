### Task 9: Tools — claims, messages, transfer, end

**Base:** `d1-front-desk` after Tasks 3 and 4 are merged. **[C1]** Today follow-ups are `jobs.next_step`/`next_step_on` (C1 T1/T6) and `updateJob`; C1 T9 work hours for `transferPlan`. Real: `Mailer`, `company_members` view, `memberships.transfer_phone_e164`/`on_call_order` (T1).

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `repos/claim-intakes.ts` + `tools/claim.ts` (job required for verified callers with one open job, else a new Lead job; activity "Claim details taken by Front Desk"); Builder 2 `tools/message.ts` (Today follow-up to the job's rep or the office, urgent → in-app + email to on-call members); Builder 3 `tools/{transfer,end}.ts` (return `handoff`/`end` engine events; `transferPlan` from on-call members with transfer phones and work hours) + tests.

**Files:** Fill the listed files; Test `apps/api/test/front-desk/tools-handoff.test.ts`.

**Tests:**
- claim intake stored and linked; message follow-up assignee rules; urgent notice once; transfer plan modes by hours/urgency; no on-call members → message mode; end with spam marks the conversation.

**Carries and rulings:**
- Follow-ups are C1 next steps on the job (no new table).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Front Desk takes claim details and messages and hands off to people`
