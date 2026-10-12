
# G1 Task 4 report: Claude drafting and claim-reply extraction

Built (branch g1-t4, commit 9b687a8):
- B1-draft: apps/api/src/providers/anthropic/draft-texts.ts, draft-prompts.ts (createDraftTexts, DRAFT_SCHEMA, prompts; first text per jobId kept; length and claimsGuard filters).
- B2-extract: extract-claim.ts (createExtractClaimReply, CLAIM_REPLY_SCHEMA, EXTRACT_PROMPT; refusal throws LlmRefusedError; four survivor checks; date window).
- B3-tests: anthropic-draft, anthropic-extract, anthropic-index tests and fixtures under apps/api/test/fixtures/anthropic/.

Review 1: verify passed, 0 findings. Minors: no separate test for AGENT_DRAFT_MODEL / AGENT_EXTRACT_MODEL defaults (covered by request-body model assertions).

Verify: npm run typecheck and npm run lint passed with no changes needed. CI result: see final status line below.
CI: run 38222148929 PASSED (commit 9b687a8).
