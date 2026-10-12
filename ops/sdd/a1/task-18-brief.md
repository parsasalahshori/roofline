### Task 18 (track lead, whole-branch review fixes C): the Agents web screens

**Base:** `a1-agents` after Tasks 16 and 17 (the contract now has `hourlyRateCents: number | null`, `RecentTask.href`, `PauseResult`; reps get null rates and link-less rules). Findings: `ops/sdd/a1/review/findings-web.md` (W-*) and `findings-numbers.md` (N-2, N-8). Read them first and re-verify each against the code.

**Own every W-* item in findings-web.md, plus:**
- N-2/W-I4 money line: "≈ $870 of staff time at $28/hour (estimate)" on the overview totals line and the agent page, with a link to Settings → Company for the owner; the card shows "≈ $870 (estimate)"; nothing about money when `hourlyRateCents` is null.
- N-8/W-M1 `hoursLabel` (`packages/shared/src/metrics.ts`): under 15 minutes "less than half an hour", thousands separators; keep the "about"/"(estimate)" copy test meaningful (allow "less than" as the approximate marker) and update its tests.
- W-T2 e2e waiting-list spec: after opening the draft from the waiting list, assert the review shows the draft (find out why the first dialog assertion failed: the review renders inside the approvals AppWindow dialog; locate it by its window title or the draft title). Do not weaken any other assertion.

**Files:** `apps/web/src/features/agents/*`, `apps/web/src/features/settings/{CompanyTab.tsx,api.ts}`, `apps/web/src/copy/{agents,status,settings}.ts`, `packages/ui` only if a `labelHidden` prop on `Field` is the clean fix (keep it backward compatible), `packages/shared/src/metrics.ts` + its test, web tests and `apps/web/e2e/agents*.spec.ts`.

**Verify:** web vitest, typecheck, lint, lint:css, build:web, playwright --list; `ci-check` with `CI_JOBS="Platform E2E"`.

Commit: `fix(web): Agents screens keep data on errors, show the rate, respect roles and time zones (A1 review)`
