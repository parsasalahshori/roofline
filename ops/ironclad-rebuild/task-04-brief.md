# Task 04: Top bar, search and account menu

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-04`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

All files under `apps/web/src/shell/topbar/`; `packages/ui/src/components/TopBar/`; `apps/web/src/copy/{shell,search}.ts`; existing web tests `top-bar.test.tsx`, `ok-pill.test.tsx`, `user-menu.test.tsx`, `search-dialog.test.tsx`, `company-switch.test.tsx`; new `apps/web/test/ironclad-topbar.test.tsx`.

Also own `ops/ironclad-rebuild/task-04-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Match the live reference's header layout, branding treatment, counts, weather, search and account menu. Preserve all existing destinations, keyboard search, loading/error states, roles and accessible names. Keep actual company name/data; reference branding must not replace tenant information with fabricated live data. Keep phone conditional behavior and all company-switch/sign-out hooks unchanged. Task 05 owns top-bar shell insets; Task 01 owns small shared primitives. Reuse existing copy rather than scattering literal JSX text.

## Smallest meaningful verification

Run focused topbar, search, user-menu and company-switch tests, typecheck and CSS lint. Check long company names and narrow widths when runtime access exists; report screenshots accurately.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-04`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
