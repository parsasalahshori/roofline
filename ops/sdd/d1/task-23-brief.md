### Task 23: Web: Settings → Front Desk and transfer phones

**Base:** `d1-front-desk` after Task 20 is merged. Real (F3): `TeamTab.tsx` pattern; **[C1]** Settings tabs.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `FrontDeskTab.tsx` (on/off with reason, texts, voice previews, facts with a counter, what it may do, ring team first, text-back, retention, concurrency); Builder 2 on-call list ordering (drag handle + up/down buttons for keyboard) showing members' transfer phones; Builder 3 `TransferPhone.tsx` (own phone, prefilled from `users.phone_e164`, recording acknowledgement checkbox) + tests.

**Carries and rulings:**
- Each member edits only their own transfer phone.

- **Ruling DF:** the transfer phone field is prefilled from the member's `users.phone_e164` (F1) and saved to `memberships.transfer_phone_e164` only after the recording acknowledgement is ticked.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): Front Desk settings and the on-call list`
