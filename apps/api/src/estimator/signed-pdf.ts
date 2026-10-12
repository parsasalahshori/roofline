import { createHash } from 'node:crypto';
import { attachSignedPdf, decrypt, signedPdfSource, storeFile, withTenant } from '@roofline/db';
import { ESTIMATE_CLAUSE_V1, isTimeZone } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import type { JobMeta } from '../jobs/queue.ts';
import { systemContext } from '../permissions.ts';
import { pdfToBuffer, renderProposalPdf } from '../proposals/pdf.ts';

const FALLBACK_TIME_ZONE = 'America/Chicago';
const IMAGE_MISSING = 'The drawn signature image is missing from file storage.';
const IMAGE_MISMATCH = 'The drawn signature image does not match its recorded hash.';
const NOT_ATTACHED = 'The signed copy could not be attached to the signature.';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Where the sign route stores a drawn signature: content-addressed, next to the signed PDF. */
export function drawnSignatureKey(companyId: string, proposalId: string, sha256: string): string {
  return `companies/${companyId}/proposals/${proposalId}/signature-${sha256}.png`;
}

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

  // A drawn signature must be in the PDF: a missing or altered image fails the job (pg-boss retries), never a PDF without it.
  let image: Buffer | null = null;
  const drawnSha = src.signature.drawnSignaturePngSha256;
  if (drawnSha !== null) {
    const png = await deps.objectStore.get(drawnSignatureKey(companyId, proposalId, drawnSha));
    if (png === null) throw new Error(IMAGE_MISSING);
    if (sha256Hex(png) !== drawnSha) throw new Error(IMAGE_MISMATCH);
    image = Buffer.from(png);
  }

  const bytes = await pdfToBuffer(
    renderProposalPdf({
      audience: 'homeowner',
      company: src.company,
      proposal: src.proposal,
      estimateClause: src.estimateClause ? ESTIMATE_CLAUSE_V1 : null,
      signature: { record: src.signature, image, timeZone: isTimeZone(src.timeZone) ? src.timeZone : FALLBACK_TIME_ZONE },
      financing: src.financing,
    }),
  );
  const sha = sha256Hex(bytes);
  const objectKey = `companies/${companyId}/proposals/${proposalId}/signed-${sha}.pdf`;

  // Object first, outside any transaction: a failure here leaves the signature untouched and pg-boss retries.
  await deps.objectStore.put(objectKey, bytes, 'application/pdf');

  const now = deps.clock.now();
  const created = await withTenant(deps.pools, ctx, async (tx) => {
    const again = await signedPdfSource(tx, ctx, proposalId);
    if (again === null || again.pdfFileId !== null) return false;
    const fileId = await storeFile(tx, ctx, { kind: 'signed_proposal_pdf', objectKey, sha256: sha, bytes: bytes.length, contentType: 'application/pdf' }, now);
    // Throwing rolls the file row back, so a file row never exists without the signature pointing at it.
    if (!(await attachSignedPdf(tx, ctx, proposalId, fileId, sha, now))) throw new Error(NOT_ATTACHED);
    return true;
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
