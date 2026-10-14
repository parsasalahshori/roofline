import { createHash } from 'node:crypto';
import { attachSignedPdf, decrypt, getMeasurement, signedPdfSource, storeFile, withTenant } from '@roofline/db';
import { ESTIMATE_CLAUSE_V1, isTimeZone, type ProposalView, type SignedDocument } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import type { JobMeta } from '../jobs/queue.ts';
import { systemContext } from '../permissions.ts';
import { pdfToBuffer, renderProposalPdf, roofSectionsOf, type ProposalPdfInput } from '../proposals/pdf.ts';
import { BadSignaturePng, flattenSignaturePng } from './signature-png.ts';

const FALLBACK_TIME_ZONE = 'America/Chicago';
const IMAGE_MISSING = 'The drawn signature image is missing from file storage.';
const IMAGE_MISMATCH = 'The drawn signature image does not match its recorded hash.';
const NOT_ATTACHED = 'The signed copy could not be attached to the signature.';
const IMAGE_UNREADABLE = 'The drawn signature image is not a PNG this app can draw.';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Where the sign route stores a drawn signature: content-addressed, next to the signed PDF. */
export function drawnSignatureKey(companyId: string, proposalId: string, sha256: string): string {
  return `companies/${companyId}/proposals/${proposalId}/signature-${sha256}.png`;
}

/** The proposal with the signed facts (address, validity, basis and the chosen option as shown) taken from the stored document. */
function withSignedFacts(proposal: ProposalView, document: SignedDocument): ProposalView {
  const d = document.option;
  return {
    ...proposal,
    address: document.address,
    validUntil: document.validUntil,
    basis: document.basis,
    options: proposal.options.map((o) =>
      o.id === d.id ? { ...o, tier: d.tier, name: d.name, highlights: d.highlights, totalCents: d.totalCents, monthlyEstimateCents: d.monthlyEstimateCents } : o,
    ),
  };
}

/**
 * Renders and collects the PDF inside one promise: a synchronous throw from the renderer and an 'error'
 * from the document both reject it, so a rendering failure fails the job instead of escaping.
 */
function renderSignedPdf(input: ProposalPdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      pdfToBuffer(renderProposalPdf(input)).then(resolve, reject);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Renders the signed proposal, stores it, and records its sha256 on the file row and the signature.
 * Safe to retry: the object key is deterministic, and a signature that already has a file is left alone.
 * The homeowner is emailed the link once, by the run that created the file row.
 */
/** What making a signed PDF needs: a job passes the whole AppDeps; the demo seed passes just these. */
export type SignedPdfDeps = Pick<AppDeps, 'pools' | 'objectStore' | 'clock' | 'mailer'> & {
  config: Pick<AppDeps['config'], 'ENCRYPTION_KEY' | 'PROPOSAL_LINK_BASE_URL'>;
};

export async function makeSignedPdf(deps: SignedPdfDeps, companyId: string, proposalId: string, meta: JobMeta): Promise<void> {
  void meta;
  const ctx = systemContext(companyId);
  const loaded = await withTenant(deps.pools, ctx, async (tx) => {
    const source = await signedPdfSource(tx, ctx, proposalId);
    if (source === null || source.pdfFileId !== null) return null;
    // The roof sections the quote covers when some were left out of it. A signed proposal was sent, so its
    // measurement is locked: the sections are the ones priced and signed.
    return { src: source, roofSections: roofSectionsOf(await getMeasurement(tx, ctx, source.proposal.measurementId)) };
  });
  if (loaded === null) return;
  const { src, roofSections } = loaded;

  // A drawn signature must be in the PDF: a missing or altered image fails the job (pg-boss retries), never a PDF without it.
  let image: Buffer | null = null;
  const drawnSha = src.signature.drawnSignaturePngSha256;
  if (drawnSha !== null) {
    const png = await deps.objectStore.get(drawnSignatureKey(companyId, proposalId, drawnSha));
    if (png === null) throw new Error(IMAGE_MISSING);
    if (sha256Hex(png) !== drawnSha) throw new Error(IMAGE_MISMATCH);
    // Checked in full again and drawn as a flat RGB copy, which pdfkit embeds without decoding: a bad
    // image fails this job cleanly, never the process (signature-png.ts).
    try {
      image = flattenSignaturePng(png);
    } catch (err) {
      if (err instanceof BadSignaturePng) throw new Error(IMAGE_UNREADABLE, { cause: err });
      throw err;
    }
  }

  // The signed facts come from the document stored at signing (Ruling ER), so a retry or a later settings
  // change cannot alter them. A signature made before documents were stored falls back to the rows.
  const doc = src.document;
  const bytes = await renderSignedPdf({
    audience: 'homeowner',
    company: doc ? doc.company : src.company,
    proposal: doc ? withSignedFacts(src.proposal, doc) : src.proposal,
    inclusions: doc ? { [doc.option.id]: doc.option.inclusions } : undefined,
    estimateClause: doc ? doc.clause : src.estimateClause ? ESTIMATE_CLAUSE_V1 : null,
    signature: { record: src.signature, image, timeZone: isTimeZone(src.timeZone) ? src.timeZone : FALLBACK_TIME_ZONE },
    optionFinancing: doc ? { ...src.optionFinancing, [doc.option.id]: doc.option.financingTerms } : src.optionFinancing,
    roofSections,
  });
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
