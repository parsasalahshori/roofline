### Task 5: `send_personal_texts` handler — one gated text per customer

**Base:** `g1-t3` (G1 T3 + D1 T4 b548ebc + g1-agents with A1 T3–T11; Ruling AZ; not yet in g1-agents). Real: F3's `apps/api/src/messaging/send-batch.ts` (the model for this handler: lease keeper, per-customer transactions under `lockRecipient`, step message rows as the idempotency record, the gate via `gate-request.ts`, sending via `outbound.ts`, `batchResult`), G1 T2b's `send_personal_texts` payload and `claimsGuard`, T2a's `followUpAllowed`, T1's `follow_up_log` table. **[S1]** Ruling SA's per-customer render is not built: this step's bodies are already personal (one body per message), so no template rendering is needed — record that in the report.

Read first: `ops/sdd/g1/global-constraints.md`, `ops/sdd/g1/progress.md` (Rulings GX-N; T3 carries), spec §2 and §5 (Decisions 7–9), then `send-batch.ts`, `outbound.ts`, `gate-request.ts`, `tasks/handlers.ts`, `tasks/lease.ts`, `packages/shared/src/steps.ts` (`send_personal_texts`), `more-agents.ts`.

**Split:**
- Builder 1: `packages/db/src/repos/follow-up-log.ts` (+ db barrel line) and its db test.
- Builder 2: `apps/api/src/agents/personal-texts.ts` (the handler) and its registration in `tasks/handlers.ts` (replacing T3's stub line).
- Builder 3: `apps/api/test/personal-texts.test.ts`.

**Repo (`repos/follow-up-log.ts`):**
```ts
export type FollowUpLogRow = { customerId: string; jobId: string | null; kind: FollowUpKind; n: number; messageId: string | null; at: Date };
export async function followUpLogFor(tx: Tx, ctx: TenantContext, customerIds: readonly string[], since: Date): Promise<FollowUpLogRow[]>;
export async function recordFollowUp(tx: Tx, ctx: TenantContext, row: { customerId: string; jobId: string | null; kind: FollowUpKind; messageId: string; at: Date }): Promise<void>;
// n = 1 + the number of earlier rows for the same (job, kind) (customer when jobId is null); a second call with the same messageId adds nothing.
export async function lastInboundAt(tx: Tx, ctx: TenantContext, customerId: string): Promise<Date | null>;   // latest messages row direction 'in' for the customer
export async function lastStormTextAt(tx: Tx, ctx: TenantContext, customerId: string): Promise<Date | null>; // latest outbound message whose dedupe key starts with 'storm:' (S1's convention; null until S1 lands)
```

**Handler (`agents/personal-texts.ts`, `send_personal_texts`):** the same structure as `send-batch.ts`, per message in payload order:
- **First statement of the per-message loop:** `if (!(await lease.keep())) return { status: 'running', result: {} };` (carry from F3 T12; never moved or wrapped).
- In the per-customer transaction, before the gate: (1) `claimsGuard(body)` again (send-time re-check, plan constraint) — a hit writes a `blocked` row with rule `content` and a plain reason ("This text was held: it talks about prices, coverage or the insurer."); (2) for kinds other than `reminder`/`no_show`, `followUpAllowed({ log: followUpLogFor(customer, now − 7 days), kind, customerId, jobId, now, lastInboundAt, lastStormTextAt })` — refused writes `blocked` with rule `frequency` and a plain reason per `reason` ("They replied recently.", "They got a storm text recently.", "They were texted recently.", "This claim has had enough reminders."); (3) then the gate exactly as send-batch does, with `purpose` from the payload (review requests are `marketing`, the rest `informational`, already validated by T2b).
- The message row's dedupe key: `${payload.dedupePrefix}:${customerId}`; its body is the message body as written.
- When a row is written `queued` or `scheduled` (a text that will go out), `recordFollowUp` in the same transaction with that message's id and the payload's `kind` (so spacing counts it immediately; a later failure leaves the log row, which errs on the side of fewer texts).
- Result: `{ sent, scheduled, failed, blocked: { <rule>: n } }` via the same counting as send-batch.
- Never sends to an insurer or adjuster: recipients are only `customerId`s from the payload (plan constraint; add a test that greps `apps/api/src/agents` for `adjuster_phone`/`adjusterPhone`/`adjuster_email`/`adjusterEmail` used as a recipient — none).

**Tests (`personal-texts.test.ts`, api project, CI only):** two customers texted with their own bodies and one `follow_up_log` row each (n 1); a rerun of the same step texts nobody twice; a guard hit at send time blocks only that message (rule `content`); a customer who replied 1 day ago is blocked (`frequency`), a reminder to the same customer still goes; a review request to an `express` customer is blocked by the gate (marketing needs attested/written); quiet hours → `scheduled`; the lease line is the first statement (read the source in the test, as F3 T12's test does); result counts.

**Verify:** `npm run typecheck && npm run lint` (slot); CI with `CI_JOBS="Platform E2E"`.
- Commit: `feat(api): personal texts step — one gated text per customer (G1 Task 5)`
