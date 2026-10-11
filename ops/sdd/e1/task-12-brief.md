### Task 12: Public homeowner API and e-sign

**Base:** `e1-estimator` after Tasks 4, 8 and 11 are merged. From T5: public prefix `/api/public/proposals`, `publicRateLimit()`. From T4: `canonicalJson`, `signedDocument`, `SignatureRecord`, `CONSENT_TEXT_V1`. From T11: the token hash format. Real (F3): `@roofline/db/system` allowed in `apps/api/src/public/**` (F3 Ruling 4). **[C1]** From C1 T6: `updateJob` (→ won with value; C1's `won_needs_value` rule is satisfied by the chosen total).

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `system/proposal-links.ts` (token hash → company/proposal) and `repos/proposal-public.ts`; Builder 2 `public/proposals.ts` (view, events, decline, signed.pdf); Builder 3 `public/proposal-sign.ts` (sign) and tests.

**Files:** Modify `packages/db/src/system/proposal-links.ts`, `packages/db/src/repos/proposal-public.ts`, `apps/api/src/public/{proposals,proposal-sign}.ts`; Test `apps/api/test/{proposal-public,proposal-sign}.test.ts`.

**Interfaces:**
```ts
export async function resolveProposalToken(system: Db, tokenHash: Buffer): Promise<{ companyId: string; proposalId: string; status: ProposalStatus; validUntil: string } | null>;
export async function publicProposalView(tx: Tx, ctx: TenantContext, proposalId: string, now: Date): Promise<PublicProposalView>;
export async function recordProposalEvent(tx: Tx, ctx: TenantContext, proposalId: string, e: { kind: ProposalEventKind; data?: Record<string, unknown>; ipHash: string; userAgent: string }, now: Date): Promise<void>;
export async function signProposal(tx: Tx, ctx: TenantContext, proposalId: string, s: Omit<SignatureRecord, 'documentSha256'> & { documentSha256: string }, now: Date): Promise<'signed' | 'already_signed' | 'closed'>;   // row lock; options frozen; job → won with value; other proposals of the job → replaced; activities; queue 'signed-pdf'
export async function declineProposal(tx: Tx, ctx: TenantContext, proposalId: string, reason: string | null, now: Date): Promise<'declined' | 'closed'>;
```
- **Routes (public):** `GET /api/public/proposals/:token` → `PublicProposalView` (unknown → 404 `{ error: "This proposal link doesn't work." }`; expired for signing → `status 'expired'` and still readable until valid_until + 30 days, then 410 `{ error, companyPhone }`); `POST …/view { optionId? }` → 204 (first view → `first_viewed_at`, job activity "Maria opened the proposal"); `POST …/sign { optionId, consent: true, signerName, typedSignature, drawnSignature?: base64 PNG ≤ 200 KB }` → 200 `{ signed: true }` (validation messages: "Check the box to agree to sign electronically.", "Type your full name.", "Pick an option."); `POST …/decline { reason? ≤ 500 }` → 204; `GET …/signed.pdf` → the stored PDF (404 until ready).
- **Hashes:** `document_sha256 = sha256(canonicalJson(signedDocument(view, optionId, clause)))`; `ip_hash = sha256(ip + company id)` in events; the signature row keeps the raw IP (legal record).
- **Rate limits:** 60/min/IP (Task 5) and 10 sign attempts per token per hour.

**Tests:**
- another company's token never resolves; view counts and the first-view activity; sign → signature row with the expected hash, job Won with the chosen total, other proposals replaced, `signed-pdf` queued; second sign → 409 "This proposal is already signed."; sign after valid_until → 409 "This proposal has expired."; decline; expired 410 page data; drawn signature too large → 400; no session needed; a read-only company's homeowner can still view and sign (Ruling 7).

**Carries and rulings:**
- Tokens are never logged (log a `token_hash` prefix only).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(estimator): the homeowner's proposal link — view, sign electronically, decline`
