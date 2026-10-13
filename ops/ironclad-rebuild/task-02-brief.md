# Task 02: Window, sheet and card geometry

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-02`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

`packages/ui/src/components/{Window,Sheet,Card,StatCard,EmptyState}/`; `apps/web/src/shell/AppWindow.tsx`; `packages/ui/test/layout.test.tsx`; new `packages/ui/test/ironclad-window.test.tsx`.

Also own `ops/ironclad-rebuild/task-02-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Match verified reference window anatomy, header/body/footer spacing, surface/card treatment and responsive geometry. Replace oversized 90%-viewport assumptions only with observed reference behavior. Preserve dialog labels, focus trap/return, Escape/close routing, scrollable body and pinned footer. Keep component public APIs compatible. Task 05 owns shell positioning/insets; request needed values in the report rather than editing Shell. Read existing consumers before changing generic Card/EmptyState styling.

## Smallest meaningful verification

Run UI layout tests and targeted shell/review/phone tests that consume windows; run typecheck and CSS lint. Verify focus behavior through existing tests; screenshots require actual reference/runtime access.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-02`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
