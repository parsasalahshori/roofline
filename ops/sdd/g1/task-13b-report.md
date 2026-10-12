
# Task 13b report: Follow-up agent, unsigned proposals

## Built
- P1-finder (packages/db/src/repos/follow-up-finder.ts, index export): findProposalCandidates implemented per brief. Also selects proposals.status (needed for the "viewed" flag). Every query names ctx.companyId. Only 'text' candidates are limited to one per customer; the lastInbound exclusion applies to text and call_rep.
- P2-draft (apps/api/src/agents/followup/draft.ts, test followup-proposal-draft.test.ts): proposalTemplate and draftProposalTexts; claimsGuard on every body; no proposal link in template or Llm facts. Extra tests for null-name fallbacks and empty input.
- P3-daily (apps/api/src/agents/followup/daily.ts, test followup-proposals.test.ts): runLeads became runTexts; lead step plus proposal step (dedupePrefix followup-proposal:<day>); call_rep candidates write a note via writeAgentNote (PROPOSAL_CALL_KIND) with no customer name; cap 25.

## Reviews
- Review 1: verify passed, 0 findings.

## Minors
- The commit is 8dca6d1. A further commit 6869e71 (fix member lookups to use the company_members view; touches claims/replies.ts and db scheduler.ts) appeared on g1-t13b during CI. It was not made by this task and cancelled the first CI run. Flag to the controller.

## Verify
- typecheck and lint: passed (no output errors).
- CI: first run 38243852264 cancelled (superseded by the push of 6869e71). Result of run 38244341011: see the lead's summary.
