import { createHash } from 'node:crypto';
import { attachSignedPdf, decrypt, signedPdfSource, storedFileById, storeFile, withTenant, type TenantContext } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import type { JobMeta } from '../jobs/queue.ts';
import { systemContext } from '../permissions.ts';
import { pdfToBuffer, renderProposalPdf } from '../proposals/pdf.ts';

/**
 * Renders the signed proposal, stores it, and records its sha256 on the file row and the signature.
 * Safe to retry: the object key is deterministic, and a signature that already has a file is left alone.
 * The homeowner is emailed the link once, by the run that created the file row.
 */
export async function makeSignedPdf(deps: AppDeps, companyId: string, proposalId: string, meta: JobMeta): Promise<void> {
  void meta;
  const ctx = systemContext(companyId);
  const src = await withTenant(deps.pools, ctx, (tx) => signedPdfSource(tx, ctx, proposalId));
  if (src === null || src.pdfFileId !== null) return;

  const bytes = await pdfToBuffer(
    renderProposalPdf({
      audience: 'homeowner',
      company: src.company,
      proposal: src.proposal,
      signature: { record: src.signature, image: null },
      financing: src.financing,
    }),
  );
  const sha = createHash('sha256').update(bytes).digest('hex');
  const objectKey = `companies/${companyId}/proposals/${proposalId}/signed-${sha}.pdf`;

  // Object first, outside any transaction: a failure here leaves the signature untouched and pg-boss retries.
  await deps.objectStore.put(objectKey, bytes, 'application/pdf');

  const now = deps.clock.now();
  const created = await withTenant(deps.pools, ctx, async (tx) => {
    const again = await signedPdfSource(tx, ctx, proposalId);
    if (again === null || again.pdfFileId !== null) return false;
    const fileId = await storeFile(tx, ctx, { kind: 'signed_proposal_pdf', objectKey, sha256: sha, bytes: bytes.length, contentType: 'application/pdf' }, now);
    return attachSignedPdf(tx, ctx, proposalId, fileId, sha, now);
  });
  if (!created || src.customerEmail === null || src.linkTokenEncrypted === null) return;

  try {
    const token = decrypt(src.linkTokenEncrypted, deps.config.ENCRYPTION_KEY);
    const link = `${deps.config.PROPOSAL_LINK_BASE_URL}/api/public/proposals/${token}/signed.pdf`;
    const lines = [`Hi ${src.customerFirstName ?? 'there'},`, '', 'Your signed roof agreement is ready. You can open or save your copy here:', link];
    if (src.company.phone) lines.push('', `Questions? Call us at ${src.company.phone}.`);
    await deps.mailer.send({ to: src.customerEmail, subject: `Your signed roof agreement with ${src.company.name}`, text: lines.join('\n') });
  } catch {
    // The PDF is stored; a failed email must not fail or retry the job. Nothing is logged: the error could carry the link.
  }
}

/** The bytes and content type of a stored file, or null when the row or the object is missing. */
export async function readStoredFile(deps: AppDeps, ctx: TenantContext, fileId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const row = await withTenant(deps.pools, ctx, (tx) => storedFileById(tx, ctx, fileId));
  if (row === null) return null;
  const bytes = await deps.objectStore.get(row.objectKey);
  return bytes === null ? null : { bytes, contentType: row.contentType };
}
