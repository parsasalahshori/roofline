
# Task RC-1 report (S1 lead)

Commit 77dc775d on d1-rc1: fix(api): front desk keeps SMS threads, identity and notes straight (RC-1).

## Built
- A-db-router: insertTurn locks the conversation row and allocates positions (NewTurn.position ignored); new repo conversation-identity (load/save stored identity, verify failures); route intent parse narrowed to the enum (tests use an okRoute helper because the shared fixture has an out-of-enum intent).
- B-engine-tools: save-turn drops explicit positions and rethrows 23505; person-ask and failed-understanding counted once per turn; system notes queue until the model call; verify lockout (MAX_FAILURES, VERIFY_LOCKED) and identity persistence in caller tools; systemCtx shared from tools/system-ctx.ts.
- C-texts: SMS state restored from stored turns and identity; skips for blocked numbers, team hold, 40-turn limit; unknown texters identified by an exact phone match; mid-turn text answered then requeued.

## Review rounds
- Review 1: verify failed, 0 findings.

## Minors / open
- Text threads older than 30 minutes (created_at based turnLimit) get no AI reply; lead to rule whether SMS should measure from the current burst.
- Local typecheck shows one environment error only (apps/web/vite.config.ts cannot find @vitejs/plugin-react: not installed in this worktree's node_modules). Copied @types/ws into the ignored node_modules.

## Verify
- lint clean; vitest @roofline/shared 846 passed; api front-desk folder 36 files / 486 tests passed; db turns + identity 15 passed; anthropic-route + fakes 23 passed.
- CI run 38289837006: E2E passed; Platform FAILED only on packages/db/test/rls.test.ts (generic CASES entry for blocked_numbers: control update gets 42501 because review note 31 revoked UPDATE on blocked_numbers; line 1452 and 1475). Lint, lint:css and typecheck steps passed in CI. Not caused by RC-1 (no schema or rls.test change here); fix belongs in rls.test.ts (blocked_numbers case needs an updatable:false path) and was not made because the file is outside RC-1's list.
