### Task 12: Lease heartbeat for long batches

**Split:**
- Builder 1: `renewStepLease` and `leaseKeeper`.
- Builder 2: the `send-batch.ts` loop.
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/tasks.ts`, `packages/db/src/index.ts` (export), `apps/api/src/tasks/runner.ts`, `apps/api/src/messaging/send-batch.ts`
- Test: `apps/api/test/lease-heartbeat.test.ts`

**Interfaces:**
```ts
export async function renewStepLease(tx: Tx, ctx: TenantContext, stepId: string, runSeq: number, leaseExpiresAt: Date): Promise<boolean>;
// UPDATE ... SET lease_expires_at WHERE id, company, status='running', run_seq=runSeq, lease_expires_at IS NOT NULL
export const LEASE_RENEW_EVERY_MS = 60_000;
export function leaseKeeper(deps: AppDeps, ctx: TenantContext, step: StepRow): { keep(): Promise<boolean> };
```
- **`keep()`:**
  - It renews to `now + LEASE_MS` when at least `LEASE_RENEW_EVERY_MS` has passed (by `deps.clock`) since the claim or the last renewal.
  - It returns false once a renewal finds the step no longer this run's, and stays false.
- **`sendSmsBatch`** calls `keep()` before each customer. When it is false, the handler stops and returns `{ status: 'running', result: {} }`; the runner drops that outcome, since the run is stale.

- [ ] **Step 1: Write the failing tests**
  - `test('a batch that runs longer than the lease keeps it')`:
    - 15 attested customers; each `send` advances `t.clock` by 60 s.
    - After the 12th send (12 minutes in), `sweepQueued(deps, clock.now())` puts nothing back.
    - The step ends `done` with 15 sent.
  - `test('a run that lost its step stops texting')`: on the 3rd send the adapter bumps the step's `run_seq` by SQL and advances 61 s → 3 texts sent in all by that run, and nobody is texted twice when a second run finishes the batch.
  - `test('renewStepLease needs the run number')`: the wrong `runSeq` → false; the right one → true and the lease moved.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `fix(tasks): lease heartbeat so long batches keep their step`

---

