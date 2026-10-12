import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import type { FinancingTerms, ProposalView, SignatureRecord, SignedDocument, StoredFileKind } from '@roofline/shared';
import { companies, customers, proposalSignatures, proposals, storedFiles } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { proposalOptionTerms, signedDocumentOf } from './proposal-public.ts';
import { getProposal } from './proposals.ts';

export async function storeFile(
  tx: Tx,
  ctx: TenantContext,
  f: { kind: StoredFileKind; objectKey: string; sha256: string; bytes: number; contentType: string },
  now: Date,
): Promise<string> {
  const [row] = await tx
    .insert(storedFiles)
    .values({ companyId: ctx.companyId, kind: f.kind, objectKey: f.objectKey, sha256: f.sha256, bytes: f.bytes, contentType: f.contentType, createdAt: now, updatedAt: now })
    .returning({ id: storedFiles.id });
  if (!row) throw new Error('The file record was not saved.');
  return row.id;
}

const UNKNOWN_CONSENT_VERSION = 'The signature has a consent version this app does not know.';

/** The stored consent version, read from the row; a version this code does not know is an error, never a guess. */
function consentVersionOf(stored: string): SignatureRecord['consentVersion'] {
  if (stored !== 'v1') throw new Error(UNKNOWN_CONSENT_VERSION);
  return stored;
}

export type SignedPdfSource = {
  proposal: ProposalView;
  signature: SignatureRecord;
  /** Set when the signature already has a stored PDF (the job then does nothing). */
  pdfFileId: string | null;
  /** Today's company name and phone (for the email). The PDF prints the signed ones from `document`. */
  company: { name: string; phone: string | null };
  /** The company's time zone as stored (the caller checks it). */
  timeZone: string;
  /** The document signed, as hashed and stored at signing (Ruling ER); null for a signature made before it was stored. */
  document: SignedDocument | null;
  /** Each option's financing terms by option id: frozen with its price, or today's settings for an older option. */
  optionFinancing: Record<string, FinancingTerms | null>;
  /** Without a stored document only: true when the signed option's "Estimate" clause applies (basis 'estimate' and its clause on). */
  estimateClause: boolean;
  customerEmail: string | null;
  customerFirstName: string | null;
  linkTokenEncrypted: Buffer | null;
};

export async function signedPdfSource(tx: Tx, ctx: TenantContext, proposalId: string): Promise<SignedPdfSource | null> {
  const [sig] = await tx
    .select()
    .from(proposalSignatures)
    .where(and(eq(proposalSignatures.companyId, ctx.companyId), eq(proposalSignatures.proposalId, proposalId)))
    .limit(1);
  if (!sig) return null;
  const proposal = await getProposal(tx, ctx, proposalId);
  if (!proposal) return null;
  const signature: SignatureRecord = {
    optionId: sig.optionId,
    signerName: sig.signerName,
    typedSignature: sig.typedSignature,
    drawnSignaturePngSha256: sig.drawnSignaturePngSha256,
    consentText: sig.consentText,
    consentVersion: consentVersionOf(sig.consentVersion),
    documentSha256: sig.documentSha256,
    totalCents: sig.totalCents,
    ip: sig.ip ?? '',
    userAgent: sig.userAgent ?? '',
    signedAt: sig.signedAt.toISOString(),
    viewedFirstAt: sig.viewedFirstAt ? sig.viewedFirstAt.toISOString() : null,
  };
  const [company] = await tx.select({ name: companies.name, phone: companies.phoneE164, timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  const terms = await proposalOptionTerms(tx, ctx, proposalId);
  const document = await signedDocumentOf(tx, ctx, proposalId);
  const [cust] = await tx
    .select({ name: customers.displayName, emails: customers.emails })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, proposal.customer.id)))
    .limit(1);
  const [tok] = await tx
    .select({ encrypted: proposals.linkTokenEncrypted })
    .from(proposals)
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, proposalId)))
    .limit(1);
  const first = cust?.name.trim().split(/\s+/)[0] ?? '';
  return {
    proposal,
    signature,
    pdfFileId: sig.pdfFileId,
    company: { name: company?.name ?? '', phone: company?.phone ?? null },
    timeZone: company?.timezone ?? '',
    document,
    optionFinancing: Object.fromEntries(Object.entries(terms).map(([id, t]) => [id, t.financing])),
    estimateClause: proposal.basis === 'estimate' && (terms[sig.optionId]?.estimateClause ?? true),
    customerEmail: cust?.emails[0] ?? null,
    customerFirstName: first === '' ? null : first,
    linkTokenEncrypted: tok && tok.encrypted.length > 0 ? tok.encrypted : null,
  };
}

/** Sets pdf_file_id and pdf_sha256 on the proposal's signature. Returns false when no signature row matched. */
export async function attachSignedPdf(tx: Tx, ctx: TenantContext, proposalId: string, fileId: string, sha256: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(proposalSignatures)
    .set({ pdfFileId: fileId, pdfSha256: sha256, updatedAt: now })
    .where(and(eq(proposalSignatures.companyId, ctx.companyId), eq(proposalSignatures.proposalId, proposalId), isNull(proposalSignatures.pdfFileId)))
    .returning({ id: proposalSignatures.id });
  return rows.length > 0;
}

/**
 * The proposals whose signature was made before `before` and still has no signed PDF, oldest first:
 * the sweep queues their 'signed-pdf' job again (its retries ran out, or it was never queued).
 */
export async function signaturesWithoutPdf(tx: Tx, ctx: TenantContext, before: Date): Promise<string[]> {
  const rows = await tx
    .select({ proposalId: proposalSignatures.proposalId })
    .from(proposalSignatures)
    .where(and(eq(proposalSignatures.companyId, ctx.companyId), isNull(proposalSignatures.pdfFileId), lt(proposalSignatures.signedAt, before)))
    .orderBy(asc(proposalSignatures.signedAt), asc(proposalSignatures.proposalId));
  return rows.map((r) => r.proposalId);
}
