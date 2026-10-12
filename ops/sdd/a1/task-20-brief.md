### Task 20 (track lead): rerun keeps switched-off steps (sentinel pass 9, item 3)

**Base:** `a1-agents` after Task 19 (both edit `apps/api/src/tasks/service.ts`).

**Problem:** `rerunTask` copies only `{ type, payload }` for each step. Since S1, a draft can hold steps saved switched off (`enabled = false`, `errorPlain` = the plain reason, payload possibly incomplete, e.g. a storm text batch with `customerIds: []`). A rerun of such an expired plan fails with a 400 on `steps.N.payload`, and a rerun of a plan where the owner switched a step off silently turns it back on.

**Decision (track lead, Ruling AX-P; S1 informed through the controller):** a rerun copies each step's on/off state. A step with `enabled = false` is passed to `createTask` with `off: step.errorPlain ?? <the copy's generic switched-off reason>`, so its payload is kept as given (no 400) and it stays off. Steps that were on are re-checked as today. Re-drafting storm plans through `draftStormPlan` is not used: a rerun must copy the expired plan, not build a fresh one.

**Do:** the change in `rerunTask` (read the `off` handling in `createTask` and `listSteps` to get `enabled`/`errorPlain`); tests (db-backed, CI only) in `apps/api/test/task-events.test.ts` or the existing rerun tests: an expired draft with one switched-off step (incomplete payload) reruns into a draft whose copy of that step is still off with the same reason, and the other steps are on; the events of the rerun stay as today (`created` by the user).

**Files:** `apps/api/src/tasks/service.ts` and the rerun test file only.

Commit: `fix(api): rerun keeps switched-off steps off`
