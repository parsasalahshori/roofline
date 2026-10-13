# Task 10: Backend contract preservation and regression audit

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-10`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

Read-only access to application/backend source. Write only new `apps/web/test/ironclad-contracts.test.tsx`, new `apps/web/e2e/ironclad-regression.spec.ts`, and new artifacts under `ops/ironclad-rebuild/qa/`, plus own handoff report. No existing tests, fixtures, configs or production files may be edited.

Also own `ops/ironclad-rebuild/task-10-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Audit baseline routes/actions, hooks/types, RBAC, session/company cache isolation, approval versions/conflicts and demo/live/provider guards. Produce a concise baseline capability matrix and risk checklist grounded in code. Add the smallest meaningful regression checks for behaviors at risk in the redesign, using existing helpers/fakes; do not mirror implementation or assert arbitrary visual constants. Document absent F2 capabilities explicitly. Compare task reports and integrated output only when supplied; do not treat unmerged branches as a tested integration. Report any required production fixes to the controller; this task never makes them. Never read/print secrets, run live sends or mutate production.

## Smallest meaningful verification

Run the newly added focused test if dependencies are already available; list new Playwright tests without Docker, or run them only against authorized fake/local stack when supported. Record command results and blockers. Final all-task integration and CI remain controller-owned; never claim they passed without evidence.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-10`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
