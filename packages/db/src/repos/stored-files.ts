import { and, eq, isNull } from 'drizzle-orm';
import type { ProposalView, SignatureRecord, StoredFileKind } from '@roofline/shared';
import { companies, companySettings, customers, proposalSignatures, proposals, storedFiles } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
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
  company: { name: string; phone: string | null };
  /** The company's time zone as stored (the caller checks it). */
  timeZone: string;
  financing: { aprBps: number; months: number } | null;
  /** True when the signed option's "Estimate" clause applies (basis 'estimate' and the company clause setting is on). */
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
  const [settings] = await tx
    .select({ apr: companySettings.financingAprBps, months: companySettings.financingTermMonths, clause: companySettings.estimateChangeClause })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
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
    financing: settings && settings.apr !== null && settings.months !== null ? { aprBps: settings.apr, months: settings.months } : null,
    estimateClause: proposal.basis === 'estimate' && (settings?.clause ?? true),
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
