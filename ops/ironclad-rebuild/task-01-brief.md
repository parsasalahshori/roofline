# Task 01: Shared tokens and small primitives

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-01`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

`packages/ui/src/tokens.css`, `tokens.ts`, `base.css`; files in `packages/ui/src/components/{Avatar,Badge,Button,Field,IconButton,Pill,Select,Skeleton,Toggle,Toast}/`; `packages/ui/test/tokens.test.ts`; new `packages/ui/test/ironclad-primitives.test.tsx`.

Also own `ops/ironclad-rebuild/task-01-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Translate verified Ironclad colors, typography, border/shadow treatment and control density into existing token names and primitives. Keep CSS/TypeScript token mirrors synchronized. Preserve public props, semantic roles, state attributes, busy/disabled behavior, contrast and focus. Card/StatCard/EmptyState/Window/Sheet/Dock/TopBar/ReviewSteps belong elsewhere. Do not edit `index.ts`. Report the token contract early so other tasks can consume it without duplicating values.

## Smallest meaningful verification

Run focused UI token/primitives tests (including existing `primitives.test.tsx`), typecheck and CSS lint. New tests should protect meaningful behavior or token synchronization; do not assert generated CSS class names.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-01`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
