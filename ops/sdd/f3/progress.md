# SDD ledger — plan: docs/superpowers/plans/2026-10-11-roofline-f3-setup.md

F3 on branch f3-setup (7b4e8b4, stacked on f2-shell 5494fc1). Team structure per Ruling K (F2 ledger). Task worktrees ~/RooflineWork/wt/f3-t<N>.
Team wave F3-1 (workflow): T1, T2, T8 (Opus contact 2), T12 (Opus contact 3).
Team wave F3-1 launched: run wf_04865695-7fc (script .superpowers/sdd/roofline-team.js in the main checkout). Contact 2: T1, T2, T8; contact 3: T12.
Relaunched in resume mode: wf_5166646f-a82 (dbtest slots).
Cloud wave launched (2026-10-11): group C (T1, T2, T8 resume, ci) wf_4bc5b561-f71; T12 resumes in group D wf_97a6d639-216 (with F2 T5). See F2 ledger Ruling R.
Group C (wf_4bc5b561-f71, contact 7): T1 4e6971a, T2 3d92b01, T8 0466b73 were already complete in their WIP commits; review round 1 clean for each; CI platform job green (runs 38177661443, 38177661487, 38177661881). Commit messages stay "wip(...)" (pushed history is not rewritten).
Task 1: complete (7b4e8b4..4e6971a). Task 2: complete (7b4e8b4..3d92b01). Task 8: complete (7b4e8b4..0466b73).
Carry to Task 3: when USAGE_KINDS moves to packages/shared/src/billing.ts, replace the db enums.ts UsageKind with `export { USAGE_KINDS, type UsageKind } from '@roofline/shared'` (contact 7).
Minors (deferred): recordUsage sets createdAt/updatedAt from input.at; GIN indexes not CONCURRENTLY; insertInboundText has no ON CONFLICT for messages_inbound_sid_uniq (decide in Task 10); revokeDataApiExposure functions revoke not 42501-guarded; revokeOnPgboss 42501 skip not logged; preflight script prints raw stack on connect failure; send() unknown-failure message hard-coded.
Merged into f3-setup: fb3db4c (T1), a23bf2a (T2), d629c74 (T8); typecheck clean; pushed; CI confirms T1+T2 together (contact 7's note).
Sibling 2 (session_01NbXKpWjMvEQwTqNmQCt6wp): F3 T3, T4, T5 from f3-setup d629c74 (contacts 31-33); reports + merge notes on branch ops-sib2.
Sibling 3 (session_01RypesnL2fbawyJH5HtdS7E): F3 T6, T10 from f3-setup d629c74, then T11 stacked on f3-t10 (contacts 41-44); reports + merge notes on branch ops-sib3.
Held for the controller: T7 (needs T5 + T6, Ruling T); T9 API skeleton (needs F2 T6-T9 in f2-shell, then f2-shell into f3-setup).
Group D (wf_97a6d639-216, contact 10): T12 10693ab already complete; review clean; CI 38177661676 green after one re-run of the rep-visibility flake. Task 12: complete (7b4e8b4..10693ab). Merged into f3-setup 4633b10 (typecheck clean).
Carry to Task 13: keep `if (!(await lease.keep())) return { status: 'running', result: {} };` as the first statement in send-batch.ts's per-customer loop; branch T13 from f3-setup after 4633b10.
Hazard: editing an ops/bin script in place while an agent runs it breaks that run (bash reads scripts incrementally). Replace scripts atomically (write a temp file, then mv).
CI: f3-setup 4633b10 (T1+T2+T8+T12) Platform job green, run 38179418220 (v1 job red only from the pre-0b81e1b empty data file; fixed when f2-shell merges in).
Sibling 3 wave 1 (wf_f8f09095-c88, contact 41): T6 1ca87f9 (CI 38179529475 green), T10 d1e0d9b (CI 38179515041 green), both review round 1 clean. T10 resolves the insertInboundText minor: onConflictDoNothing on (company_id, provider_message_sid) WHERE direction='in', returns null on repeat; /sms does nothing on null.
Task 6: complete (d629c74..1ca87f9). Task 10: complete (d629c74..d1e0d9b). Merged into f3-setup 03782f5, d83f815; typecheck + lint clean.
Minors (deferred): T10 stores the normalized body as the opt-out keyword on OptOutType=STOP (consider a cap); locks before the dedupe insert; no db-level test for includeInactive; T6 hard-codes "20,000" instead of MAX_IMPORT_ROWS; non-finite number cells render 'NaN'.
Sibling 2 (wf_13479391-707, contact 31): T3 b857c5d (1 round, lint fix; carry done: db enums.ts re-exports USAGE_KINDS/UsageKind from shared) CI 38180141961; T4 18a3eef CI 38179479139; T5 2dd3312 (Rulings T, V) CI 38179525445. All Platform green, reviews clean. Notes: ops/sdd/f3/merge-sib2.md.
Task 3: complete (d629c74..b857c5d). Task 4: complete (d629c74..18a3eef). Task 5: complete (d629c74..2dd3312). Merged into f3-setup (head 0351174); typecheck, lint, shared tests clean.
Carry to T7: BrandInfoSchema rejects full state names by design; toUsStateCode accepts them. Carry to T18/T19/T33: T3's no-hard-coded-prices test fails any src file containing 19900/39900.
Minors (deferred): T4 SetupFacts.texting.rejectedFields is string[] vs T5's BrandField[] (tighten later); T5 split campaign helpers into texting-campaign.ts re-exported from texting.ts.
F3 Task 9 (API skeleton): brief ready; assigned to sibling 1 (session_01MpVA7xTz6Bus8WPNZWUKRq), branch f3-t9 from f3-setup baf4c93, contact 23.
Sibling 2 (wf_8adb9634-824, contact 35): T7 76aa441 (base 0351174), review clean, CI 38181073895 green. Task 7: complete. Merged into f3-setup (see git log). Notes: ops/sdd/f3/merge-sib2b.md.
Carry to T23/T24 (important): move ExistingCustomer, ExistingIndex, NormalizedRow, RowSkip (type-only) into packages/shared/src/imports.ts; normalize.ts and plan.ts re-export them; db must not redefine them. T24 must not record attestation evidence for a matched customer with no phone (importConsent ignores hasPhone).
Minors (deferred): badPhone checked before email (brief order); previewRows prints blank address parts; normalizeZip truncates '123456' to '12345'; T6's hard-coded "20,000" still open.
Architect 2 briefs: task 9, 13-24 written (ops/sdd/f3/briefs-status.txt). Proposed groups: G1 (after T9) T18, T19, T20; G2 (after T9) T16, T21, T22; G3 (after T9) T14, T15, T17; G4 (after T7 + T11) T13, T23, then T24 stacked on T23.
Ruling X: T4's rejectedFields stays string[]; T16 keeps only values in BRAND_FIELDS — cost if wrong: none.
Ruling Y: with STRIPE_WEBHOOK_SECRET unset the Stripe webhook answers 503 and records nothing (Stripe retries) — cost if wrong: retried events.
Ruling Z: T22 reads the Stripe customer id with its own small query, not T19's billingFacts — cost if wrong: one duplicated query.
Ruling AA: InlineJobs records every thrown error (T9 brief amended; sibling 1 told) — cost if wrong: none.
Ruling AB: the import job bulk-writes customers, homes and jobs instead of createCustomer (no audit row per customer) — cost if wrong: ~900 extra audit rows.
Ruling AC (controller, overrides Architect 2's local-copies proposal): T7's ExistingCustomer, ExistingIndex, NormalizedRow and RowSkip move type-only into packages/shared/src/imports.ts (T23 does the move); apps/api normalize.ts/plan.ts re-export them and packages/db imports them from @roofline/shared — no duplicated declarations (sibling 2's group check) — cost if wrong: one moved type block.
T13 starts only after T11's review is merged (both edit messages.ts).
