# Task 08: Settings surfaces

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-08`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

`apps/web/src/features/settings/{Settings.tsx,Settings.module.css,CompanyTab.tsx,CompanyTab.module.css,TeamTab.tsx,TeamTab.module.css,LaterTab.tsx}`; `apps/web/src/copy/settings.ts`; existing web tests `settings.test.tsx`, `settings-company.test.tsx`, `settings-team.test.tsx`; new `apps/web/test/ironclad-settings.test.tsx`.

Also own `ops/ironclad-rebuild/task-08-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Match verified settings layout, tab treatment, company forms and team tables. Preserve existing fields, dirty/save behavior, field errors, owner-only edits, non-owner read-only view, spending permissions, invitation form and member enable/disable controls. Freeze feature `api.ts`, `tabs.ts`, shared hooks/types and routes; retain self-demotion query invalidation and server last-owner enforcement. Connections/billing/setup are placeholders in F2: visually improve truthful empty states, without claiming integrations or billing features exist. Do not enter credentials or create/send a real invitation during validation.

## Smallest meaningful verification

Run focused settings/company/team tests, typecheck and CSS lint. Verify owner and non-owner rendering, form errors and pending states with existing fakes.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-08`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
