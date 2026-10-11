### Task 11: Sending — the Estimator agent's step and the link

**Base:** `e1-estimator` after Tasks 4 and 8 are merged. Real (F3): `messaging/send-batch.ts` (`sendSmsBatch`; the lease line `if (!(await lease.keep())) return { status: 'running', result: {} };` stays first in the loop), `messaging/gate-request.ts`, `messaging/outbound.ts`, `encrypt` (`packages/db/src/crypto.ts`). **[C1]** From C1 T6: `updateJob` stage rules (lead/inspection → proposal).

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `estimator/send-proposal.ts` (task creation, link token mint, body render) and the `send_proposal` handler; Builder 2 `messaging/send-batch.ts` export `sendOneText` (one recipient, purpose given) and the job stage move; Builder 3 `routes/proposals.ts` (`/send`, `/link`) additions and tests.

**Files:** Modify `apps/api/src/estimator/send-proposal.ts`, `apps/api/src/messaging/send-batch.ts` (export only; the lease line stays first in the loop), `apps/api/src/tasks/handlers.ts` (`send_proposal` → `sendProposalStep`), `apps/api/src/routes/proposals.ts`; Test `apps/api/test/proposal-send.test.ts`.

**Interfaces:**
```ts
export const PROPOSAL_TEXT_TEMPLATE = "Hi {first_name}, it's {company}. Here's your roof proposal for {address}: {link} Reply STOP to opt out.";
export async function draftProposalSend(deps: AppDeps, ctx: TenantContext, proposalId: string): Promise<{ taskId: string }>;   // proposal → 'ready'; one send_proposal step; idempotent per proposal (an open draft task is returned)
export const sendProposalStep: StepHandler;   // mint link once (32 bytes, hash + encrypted), render {link} → `${PROPOSAL_LINK_BASE_URL}/p/<token>`, sendOneText(purpose 'informational', dedupeKey 'proposal:<id>'); sent → proposal 'sent', sent_at, job → proposal (C1 rules: only from lead/inspection), activity, event 'sent'; blocked → step result blocked with the gate's reason, proposal back to 'draft'
export async function sendOneText(deps: AppDeps, ctx: TenantContext, step: StepRow, i: { customerId: string; purpose: MessagePurpose; body: string; dedupeKey: string; bodyRendered: true }): Promise<'sent' | 'scheduled' | 'blocked' | 'failed' | 'refused'>;
export function linkFor(config: Config, token: string): string;
```
- **Routes:** `POST /api/proposals/:id/send` → `{ taskId }` (owner, office, or the rep who owns the job — reps can't approve, the draft waits for owner/office); `GET /api/proposals/:id/link` (owner/office) → `{ url }`, event `link_copied`; a signed proposal's link never changes.

**Tests:**
- send → task with the step preview (three totals, "Estimate"); approve → one text with the link, proposal sent, job Proposal, event; no consent → blocked with the gate reason and proposal back to draft; quiet hours → scheduled, proposal sent when the dispatcher sends (status follows); idempotent send task; the token's hash resolves (Task 12 helper stub) and the plain token is never in logs; `{link}` removed in an edit → refused.

**Carries and rulings:**
- `messaging/send-batch.ts`: add the `sendOneText` export only; keep the lease line first in the per-customer loop.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(estimator): the Estimator agent drafts the proposal text; one approval sends it`
