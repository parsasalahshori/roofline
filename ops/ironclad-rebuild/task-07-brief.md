# Task 07: Approvals and review

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-07`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

`apps/web/src/features/approvals/{ApprovalsList.tsx,ApprovalsList.module.css,Review.tsx,Review.module.css,EditStepSheet.tsx,NotNowSheet.tsx,ApprovalSheets.module.css}`; `packages/ui/src/components/ReviewSteps/{ReviewSteps.tsx,ReviewSteps.module.css}`; `apps/web/src/copy/{approvals,review}.ts`; existing web tests `approvals-list.test.tsx`, `approval-sheets.test.tsx`, `review.test.tsx`, `review-copy.test.ts`; `packages/ui/test/review-steps.test.tsx`; new `apps/web/test/ironclad-approvals.test.tsx`.

Also own `ops/ironclad-rebuild/task-07-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Match observed approval list, plan stats, step rows and edit/decline sheets while preserving every actual action. Freeze `api.ts`, `polling.ts`, `editable.ts`, `toReviewStep.ts`, shared types and `summarize.ts`. Keep canApprove, rep restrictions, versioned payloads, pending mutation locks, double-click guard, optimistic rollback, stale-409 reconciliation, expiry/rerun, retry, decline routing and post-approval polling. Do not change permission logic for visual convenience. Both approvals and storm-plan review routes must continue to work. Window/Sheet geometry belongs to Task 02.

## Smallest meaningful verification

Run focused review/list/sheets/copy and UI ReviewSteps tests plus existing polling/to-review-step tests; typecheck and CSS lint. Exercise busy/error/permission states with fakes; never send to real people.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-07`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
