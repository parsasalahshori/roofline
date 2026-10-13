# Task 09: Authentication, coming-soon and errors

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-09`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

`apps/web/src/features/auth/{AuthLayout.tsx,Auth.module.css,SignIn.tsx,ResetPassword.tsx,VerifyEmail.tsx,AcceptInvite.tsx}`; `apps/web/src/features/coming-soon/ComingSoon.tsx`; optional new `ComingSoon.module.css` in that directory; `apps/web/src/app/{RouteError.tsx,RouteError.module.css,RequireSession.module.css}`; `apps/web/src/shell/NotFoundWindow.tsx`; `apps/web/src/copy/{auth,comingSoon}.ts`; existing `apps/web/test/{auth,route-error}.test.tsx`; new `apps/web/test/ironclad-entry.test.tsx`.

Also own `ops/ironclad-rebuild/task-09-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Apply verified reference styling to entry forms, placeholder panels and fallback states. Preserve all auth submissions, validation, pending/error behavior, invitation verification and safe redirect handling. Freeze `safeNext.ts`, `formErrors.ts`, `RequireSession.tsx`, API/client/providers and router. Keep fallback errors confined to the same existing boundaries. Placeholder jobs/calendar/estimator/front-desk/agents/customers routes must remain truthful; do not create fake controls that imply absent backend capabilities. Never weaken auth or add demo bypasses to make screenshots convenient.

## Smallest meaningful verification

Run auth/safe-next/route-error and copy-rule tests, typecheck and CSS lint. Verify keyboard/form behavior using fakes and record unavailable visual checks honestly.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-09`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
