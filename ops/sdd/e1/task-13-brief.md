### Task 13: Signed PDF and object storage (R2)

**Base:** `e1-estimator` after Tasks 5 and 12 are merged. From T5: `ObjectStore`, `MemoryObjectStore`, stub `providers/r2.ts`, job `signed-pdf`. From T8: `renderProposalPdf`. Real (F3): `Mailer` is `{ to, subject, text }` only (no attachments) — Ruling EE.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `providers/r2.ts` (`aws4fetch` PUT/GET, private bucket); Builder 2 `estimator/signed-pdf.ts` (render with the signature page, hash, store, `stored_files`, email copy) and the `signed-pdf` job handler; Builder 3 `repos/stored-files.ts` and tests.

**Files:** Modify `apps/api/src/providers/r2.ts`, `apps/api/src/estimator/signed-pdf.ts`, `apps/api/src/jobs/handlers.ts` (`signed-pdf`), `packages/db/src/repos/stored-files.ts`; Test `apps/api/test/{r2,signed-pdf}.test.ts`, fixtures `apps/api/test/fixtures/r2/*.txt` (recorded request shapes).

**Interfaces:**
```ts
export class R2ObjectStore implements ObjectStore { constructor(o: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; fetch?: typeof fetch }) }   // https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
export function r2For(config: Config): ObjectStore | null;
export async function makeSignedPdf(deps: AppDeps, companyId: string, proposalId: string, meta: JobMeta): Promise<void>;   // render (homeowner audience + signature page + audit page), sha256, put `companies/<c>/proposals/<p>/signed-<sha>.pdf`, stored_files row, signature.pdf_file_id/pdf_sha256, email copy when the customer has an email (Postmark via deps.mailer; subject "Your signed roof agreement with <company>")
export async function storeFile(tx: Tx, ctx: TenantContext, f: { kind: StoredFileKind; objectKey: string; sha256: string; bytes: number; contentType: string }, now: Date): Promise<string>;
export async function readStoredFile(deps: AppDeps, ctx: TenantContext, fileId: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
```

**Tests:**
- R2 SigV4 request shape against a recorded fixture (host, path, `x-amz-content-sha256`, Authorization prefix); signed PDF contains the signer name, the consent text, the document hash and "Estimate" clause when on; the stored hash equals the bytes' SHA-256; idempotent job (second run doesn't duplicate); `GET …/signed.pdf` streams it; email sent once when an email exists; store failure → retried, signature row untouched.

**Carries and rulings:**
- **Ruling EE:** the email copy contains a link to `GET /api/public/proposals/:token/signed.pdf`, not an attachment (the F3 `Mailer` has no attachments); `Mailer` is not changed.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(estimator): tamper-evident signed PDF stored privately, with an email copy`
