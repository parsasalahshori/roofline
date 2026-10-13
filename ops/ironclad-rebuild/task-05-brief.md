# Task 05: Shell, dock and phone navigation

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-05`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

`apps/web/src/shell/{Shell.tsx,Shell.module.css,dockIcons.tsx,useIsPhone.ts}`; all `apps/web/src/shell/phone/`; `packages/ui/src/components/Dock/`; `apps/web/src/copy/dock.ts`; existing `apps/web/test/{shell,phone,lazy-map}.test.tsx`; new `apps/web/test/ironclad-navigation.test.tsx`.

Also own `ops/ironclad-rebuild/task-05-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Own all shell positioning, map/window/chrome layers, desktop dock and phone tabs/More sheet. Match observed reference spacing, icons, active state and responsive behavior. Preserve routes and app registry in `apps.ts` unchanged, badges, pending-draft counts, `useTodayAutoOpen()`, lazy/Suspense map loading and company-keyed MapErrorBoundary. Preserve touch targets and safe areas. Coordinate Window geometry with Task 02 and TopBar with Task 04 without editing their files. Do not mark placeholder apps shipped or bypass session/RBAC protections.

## Smallest meaningful verification

Run shell/phone/lazy-map tests and relevant existing UI layout tests, typecheck and CSS lint. Verify no chrome overlap or horizontal overflow on desktop/phone when runtime is available.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-05`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
