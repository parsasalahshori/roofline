### Task 13b: Follow-up agent — unsigned proposals (Ruling GX-Q)

**Base:** `g1-t13b` e9865ca = g1-w5m (G1 T3–T6, T8, T10, T13a, T16, T17s + Ruling GX-R live-note helper `apps/api/src/agents/notes.ts` `writeAgentNote`) + g1-agents (e1-estimator). Read Task 13a's code first: this task adds a third finder group and extends the same daily task; it does not add a new job or task kind.

Read first: `ops/sdd/g1/global-constraints.md`; `progress.md` (GX-E, GX-Q, T3/T4 carries); spec §5, Decisions 7–8; Task 13a's `packages/db/src/repos/follow-up-finder.ts` and `apps/api/src/agents/followup/{daily,draft}.ts`; T2a `proposalFollowUpDue` / `ProposalFacts` / `followUpAllowed` (`packages/shared/src/follow-up-rules.ts`); E1: `packages/shared/src/proposals.ts` (`PROPOSAL_STATUSES`), `packages/db/src/repos/proposals.ts` (`getProposalLinkToken`), `apps/api/src/estimator/send-proposal.ts` (`linkFor`, `fillProposalText`); `follow_up_log` (T5, `kind 'proposal'`, `job_id`). E1 rulings: EL (`send_proposal` totals are `{ tier, totalCents }[]`), EN (the `send_proposal` step result is `{ sent: 0 | 1 }`). Do not change E1's files.

**Split:** Builder 1 the finder group (+ facts); Builder 2 drafting and the rep-call step; Builder 3 tests.

**Finder group (c) proposals:** `followup_proposals` setting on; proposals with status `sent` or `viewed` (not `signed`, `declined`, `expired`, `replaced`, `draft`, `ready`), `sent_at` not null, customer has a mobile phone, job not lost. Facts for `proposalFollowUpDue(facts, now, company_settings.followup_days)`:
- `sentAt`, `lastViewedAt` (`last_viewed_at`), `signedAt`;
- `textsSent` / `lastTextAt`: `follow_up_log` rows `kind 'proposal'` for that job with `at >= sent_at`;
- `callRepAt`: when a rep-call note was made for this proposal (below), else null.
Then `followUpAllowed(kind 'proposal')` with the customer's log, last inbound and last storm text (as 13a). Decision 7 stop conditions apply (inbound text in the last 3 days → excluded).

**Due `'text'`:** add to the same daily `send_personal_texts` step as 13a's leads (`kind` per message: `'proposal'` — if the step payload has one `kind` for the whole batch, make a second `send_personal_texts` step in the same task with `kind: 'proposal'` and `dedupePrefix: 'followup-proposal:{localDate}'`; read T5's payload and pick whichever matches it). Body: `draftTexts({ instruction: 'proposal_follow_up', facts })` (facts: first name, rep first name, company, the proposal number, viewed or not, lowest tier total in dollars from the proposal's options); every body passes D1's `guardSentence` and `claimsGuard` (13a's helper); template fallback: "Hi {first}, it's {rep} at {company}. Just checking you got the roof proposal we sent. Happy to answer any questions — reply here or call us." The texts do not carry the proposal link (the link goes out only through E1's send/resend; cost if wrong: a later small change). If `proposal_follow_up` is not one of T4's `DRAFT_KINDS`, use the nearest existing kind and add a carry; do not change T4's prompts.

**Due `'call_rep'`:** no customer text. In a live note made with `writeAgentNote` (Ruling GX-R; 13a's stuck nudge uses it too): set C1's next step on the job to "Call {customer} about proposal {number}: two texts, no answer." with `nextStepOn` = today, when the job has no next step already; record the ask so `callRepAt` is found next time (store it as a live task subject `proposal:{id}`, or the task-event/next-step record 13a already uses — pick one, test it). After that the proposal is never followed up again.

**Daily task:** the title counts all texts ("Follow-ups for today ({n})"); the summary says how many are proposal follow-ups. Idempotent per day as 13a.

**Tests (CI):** a proposal sent 3 days ago (followup_days [3,4]) gets a text; one sent 2 days ago does not, unless viewed ≥ 2 days ago; signed/declined/replaced/expired never; a second text 4 days after the first; after two texts the rep gets a next step once and no third text; a customer who texted yesterday is skipped; spacing with a claims text 2 days ago blocks; template fallback; `followup_proposals` off → no proposal group.

**Verify:** `npm run typecheck && npm run lint` (slot); CI with `CI_JOBS="Platform E2E"`.
- Commit: `feat(api): Follow-up agent — unsigned proposals (G1 Task 13b)`
