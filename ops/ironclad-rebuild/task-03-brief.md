# Task 03: Map, home and storm presentation

Read and follow `ops/ironclad-rebuild/README.md` in full. **GPT-6 Astra only** overrides legacy model rulings. Base: `codex/ironclad-f2-rebuild` (source `0fa8126`). Branch: `codex/ironclad-ui-03`.

Exact visual authority: https://roofing-os-demo.vercel.app/ . Controller supplies screenshot extraction/assets when available; if cloud browsing/reference evidence is unavailable, report the gap and never claim visual QA. The user's faithful-reference request overrides old hard-coded visual tokens/window sizing only. All security/business rules remain in force.

## Exclusive write ownership

All files under `apps/web/src/shell/map/` except `types.ts`; `apps/web/src/features/storm/{StormWindow.tsx,StormWindow.module.css}`; `apps/web/src/copy/{map,storm}.ts`; existing `apps/web/test/map-*.test.ts*`, `pins.test.ts`, `pin-card.test.tsx`, `storm-window.test.tsx`; new `apps/web/test/ironclad-map.test.tsx`.

Also own `ops/ironclad-rebuild/task-03-report.md`. No other file edits. Preserve backend/hooks/types/RBAC/approval semantics and demo/live safeguards. No false live features absent from F2 source.

## Work

Match the verified map/home composition, control treatment, pin cards and storm entry presentation. Preserve MapLibre geographic behavior, company remount, source/layer interactions, bounds, clusters, customer/job targets and service area. An absent tile key intentionally gives a network-free background: do not silently enable external tiles or replace actual geography with a decorative fake. Storm must preserve its real newest pending-plan link; it is not full S1. Shell layout is Task 05; shared map colors come from Task 01. Do not manufacture storm data.

## Smallest meaningful verification

Run focused map style/layer/interaction/resilience/pin and storm tests, typecheck and CSS lint. Record which map mode was verified; no test/CI live tile requests.

## Handoff

Commit owned changes and push only `codex/ironclad-ui-03`. No merges, main/integration pushes or force pushes. Report SHA, files, reference evidence, preserved actions, actual checks/results, screenshots, blockers and cross-owner requests. Controller waits for all task outputs and CI before integration.
