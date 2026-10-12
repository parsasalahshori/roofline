### Task 6: Claims record and API

**Base:** `g1-t3` (as Task 5). Real: G1 T1's `claims`, `claim_events` tables and `CLAIM_STATUSES`/`CLAIM_EVENT_ACTORS`; T2a's `CLAIM_STATUS_FLOW`; D1 T1's `claim_intakes` (`jobId`, `insurer`, `claimNumber`, `dateOfLoss`, `description`, `adjusterVisitAt`, `takenBy`); C1's `jobScope(ctx)` (`packages/db/src/repos/scope.ts`) and the job routes (`apps/api/src/routes/jobs.ts`), `appointments`.

Read first: `ops/sdd/g1/global-constraints.md`, spec §3.1, §3.3, §7; `routes/jobs.ts` (style: Router, `parse`/`assertKnownFields`/`UUID` from `validate.ts`, `AppError`), `repos/scope.ts`, an existing repo with audit writes (e.g. `repos/jobs.ts`).

**Split:**
- Builder 1: `packages/db/src/repos/claims.ts` (+ barrel) and `packages/shared/src/claims.ts` (view types, + shared barrel line after `more-agents.ts`).
- Builder 2: `apps/api/src/routes/claims.ts` and its mounts in `app.ts` (one `// G1 Agents` line pair).
- Builder 3: `apps/api/test/claims.test.ts` and `packages/db/test/claims.test.ts`.

**Shared views (`packages/shared/src/claims.ts`):**
```ts
export type ClaimView = { id: string; jobId: string; insurer: string | null; claimNumber: string | null; dateOfLoss: string | null;
  status: ClaimStatus; adjusterName: string | null; adjusterPhone: string | null; adjusterEmail: string | null;
  adjusterAppointmentId: string | null; deductibleCents: number | null; notes: string | null; statusChangedAt: string;
  events: { from: ClaimStatus | null; to: ClaimStatus; by: ClaimEventActor; byName: string | null; at: string }[] };
export type ClaimIntakeView = { insurer: string; claimNumber: string | null; dateOfLoss: string | null; description: string; adjusterVisitAt: string | null };
export type JobClaimResponse = { claim: ClaimView | null; intake: ClaimIntakeView | null };   // intake = the latest D1 intake on the job, shown until a claim exists
export type ClaimBoardRow = { claimId: string; jobId: string; customerName: string; address: string | null; status: ClaimStatus; insurer: string | null; claimNumber: string | null; statusChangedAt: string };
export const CLAIM_FIELD_LIMITS = { text: 200, notes: 2000 } as const;
```

**Repo (`repos/claims.ts`):** `getJobClaim(tx, ctx, jobId): JobClaimResponse` (job must be in `jobScope(ctx)`, else null → the route says not found); `saveClaim(tx, ctx, jobId, patch, by: { actor: ClaimEventActor; userId: string | null }, now)`: creates the claim on first save (pre-filled from the latest intake on the job for any field the patch leaves out — "promoted on first save", spec §3.1), updates the given fields, and when `status` changes writes a `claim_events` row (`from` null on create) and sets `status_changed_at`; `adjusterAppointmentId` must be an appointment of the same job (else a field error); returns the new `ClaimView`; writes an audit row (`claim.created` / `claim.updated` with the changed field names only, never values). `listClaims(tx, ctx, { status?: ClaimStatus }): ClaimBoardRow[]` within `jobScope(ctx)`, ordered by `status_changed_at` desc, limit 500. People may set any status (the flow table is for the agent only, T8).

**Routes (`routes/claims.ts`):** mounted at `/api/jobs/:jobId/claim` (`GET`, `PUT`) and `/api/claims` (`GET ?status=`), after the sign-in gate like the job routes; reps see and edit claims on jobs they can see (jobScope), office and owner all. `PUT` body: any of the ClaimView editable fields (`insurer`, `claimNumber`, `dateOfLoss` YYYY-MM-DD, `status`, `adjusterName`, `adjusterPhone` (via `toE164`, or null), `adjusterEmail`, `adjusterAppointmentId`, `deductibleCents` int ≥ 0, `notes`); unknown fields refused (`assertKnownFields`); plain field errors (`{ error, field }`). Unknown job or out of scope → 404 "We couldn't find that job.". Error strings are constants in the route file.
- **Plan constraint:** the adjuster's phone and email are stored for the people at the company to read; no code path ever texts or emails them (T5's grep test covers send paths).

**Tests:** db (CI): one claim per job (second create updates), events on status change only, intake promotion fills only missing fields, appointment-of-another-job refused. api (CI): GET with an intake and no claim; PUT creates and returns events; status change history; rep scope (a rep cannot see another rep's job's claim: 404); board filter by status; validation errors with field names; cross-tenant isolation.

**Verify:** `npx vitest run --project @roofline/shared`, `npm run typecheck && npm run lint` (slot); CI with `CI_JOBS="Platform E2E"`.
- Commit: `feat(api): insurance claim records on jobs (G1 Task 6)`
