# Task 06: Today dashboard

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-06`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

`apps/web/src/features/today/{Today.tsx,Today.module.css}`; `apps/web/src/copy/today.ts`; existing `apps/web/test/today.test.tsx`; new `apps/web/test/ironclad-today.test.tsx`.

Also own `ops/ironclad-rebuild/task-06-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Recreate the verified reference's Today composition and information density using existing real data and truthful empty states. Preserve timezone-aware greeting/date, newest-first pending drafts, maximum-three list behavior, links, loading and errors. Do not edit `api.ts` or `useTodayAutoOpen.ts`; preserve its once-per-day/race protections. Baseline has no appointments hook, so do not invent live appointments, revenue or productivity numbers. Any reference-only content requiring unavailable data must be reported, not represented as functioning backend capability.

## Smallest meaningful verification

Run focused Today tests plus shell auto-open coverage, typecheck and CSS lint. Check populated, empty and loading states using existing test fixtures; reference comparison only with actual evidence.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-06`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
