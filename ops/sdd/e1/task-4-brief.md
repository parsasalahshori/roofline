### Task 4: Shared proposal types, signature record, canonical JSON, step types

**Base:** `e1-estimator` after Task 1 is merged (T2/T3 types by name — `Outline`, `InstantEstimate`, `AddOn`; stub until siblings merge). From F1/F3 (real): `packages/shared/src/steps.ts` (`STEP_TYPES`, `StepTypeDef`, `stepTypes`, the preview shape `{title, lines, messageSample, recipientCount, sendTime, maxSpendCents}`).

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 view types in `proposals.ts`; Builder 2 `canonicalJson` and `SignatureRecord`; Builder 3 the two step types in `steps.ts` and tests.

**Files:** Modify `packages/shared/src/proposals.ts`, `packages/shared/src/steps.ts`; Test `packages/shared/test/{proposals,steps-e1}.test.ts`.

**Interfaces:**
```ts
export type MeasurementView = { id: string; propertyId: string; jobId: string | null; kind: MeasurementKind; method: MeasurementMethod;
  outline: Outline | null; structures: { footprintId: string; included: boolean; areaSqFt: number }[]; estimate: InstantEstimate; facets: number | null;
  locked: boolean; providerRef: string | null; notes: string | null; createdAt: string; drawMode: boolean };
export type ProposalOptionView = { id: string; tier: Tier; name: string; highlights: string[]; scope: Scope; addOns: AddOn[]; calculation: Calculation;
  addOnLines: QuoteLine[]; totalCents: number; monthlyEstimateCents: number | null; enabled: boolean };
export type ProposalView = { id: string; number: string; status: ProposalStatus; jobId: string; customer: { id: string; name: string; phone: string | null };
  address: string; measurementId: string; basis: MeasurementKind; options: ProposalOptionView[]; messageBody: string; validUntil: string;
  sentAt: string | null; views: { count: number; first: string | null; last: string | null }; signed: { optionId: string; name: string; at: string } | null;
  declined: { reason: string | null; at: string } | null; taskId: string | null; replacedById: string | null; canEdit: boolean };
export type PublicProposalView = { companyName: string; companyPhone: string | null; firstName: string | null; address: string; validUntil: string;
  status: 'open' | 'signed' | 'declined' | 'expired'; basis: MeasurementKind; options: { id: string; tier: Tier; name: string; highlights: string[];
  inclusions: string[]; totalCents: number; monthlyEstimateCents: number | null; financingTerms: { aprBps: number; months: number } | null }[];
  signed: { optionId: string; name: string; at: string; pdfReady: boolean } | null; estimateClause: boolean };
export const CONSENT_TEXT_V1 = 'I agree to sign electronically and to receive this agreement electronically. I can ask for a paper copy.';
export const ESTIMATE_CLAUSE_V1 = "This price is based on an estimate of your roof's size. If the measured size differs, we'll show you the updated price and ask you to confirm before work starts.";
export type SignatureRecord = { optionId: string; signerName: string; typedSignature: string; drawnSignaturePngSha256: string | null; consentText: string;
  consentVersion: 'v1'; documentSha256: string; totalCents: number; ip: string; userAgent: string; signedAt: string; viewedFirstAt: string | null };
export function canonicalJson(value: unknown): string;   // sorted keys, no whitespace, numbers as JSON; arrays keep order; undefined dropped
export function signedDocument(p: PublicProposalView, optionId: string, clause: boolean): unknown;   // what document_sha256 covers: company, address, the chosen option as shown, valid until, clause text when on
```
(`CONSENT_TEXT_V1`/`ESTIMATE_CLAUSE_V1` are legal record text, stored verbatim with the signature; the web shows them from `copy/homeowner.ts` with the same words — a test asserts equality.)
- **Step types (`steps.ts`):** `STEP_TYPES` gains `'send_proposal'` (approvalClass `message`; payload `{ proposalId: uuid, customerId: uuid, body: string (1–640, must contain '{link}'), basis: MeasurementKind, totals: number[] }`; validate: `{link}` present → else "Keep {link} in the message so they can open the proposal."; preview `{ title: 'Text the proposal to <first name>', lines: ['Good $11,900 · Better $14,250 · Best $17,600', basis line], messageSample: body with a sample link, recipientCount: 1 }`; minutesSaved 20) and `'order_exact_report'` (approvalClass `spend`; payload `{ orderId: uuid, measurementId: uuid, address: string, maxSpendCents: int }`; preview `{ title: 'Order an exact roof report', lines: [address], maxSpendCents }`; minutesSaved 10). Shared formatting of dollars inside previews uses the existing step-preview helpers.

**Tests:**
- `canonicalJson` key order and stability; `signedDocument` changes when the option total changes; the two step payloads validate and preview; `{link}` rule; copy-rules (`npx vitest run --project @roofline/web copy-rules`).

**Carries and rulings:**
- `CONSENT_TEXT_V1`/`ESTIMATE_CLAUSE_V1` are stored verbatim with signatures; T19 asserts the web copy equals them.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): proposal views, the signature record and the proposal and exact-report steps`
