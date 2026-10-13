import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { ProposalView, PublicProposalView, SignatureRecord } from '@roofline/shared';
import { calculateQuote, canonicalJson, defaultPricebook, defaultScope, ESTIMATE_CLAUSE_V1 } from '@roofline/shared';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { companies, companySettings, customers, measurements, proposalEvents, proposalSignatures, proposals, storedFiles } from '@roofline/db';
import { drawnSignatureKey, makeSignedPdf } from '../src/estimator/signed-pdf.ts';
import { SIGNED_PDF_GRACE_MS, sweepSignedPdfs } from '../src/jobs/scheduler/signed-pdf-sweep.ts';
import { pdfToBuffer, renderProposalPdf } from '../src/proposals/pdf.ts';
import { addressFor, Actors, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { pdfText } from './pdf-text.ts';
import { DAYTIME } from './sms-helpers.ts';
import { dbSteps, seenOf } from './task-helpers.ts';

// The signed PDF job (E1 Task 13). DB-backed: runs on CI (Platform), never locally without Docker.

let t: TestApp;
let who: Actors;

const TOKEN_PATTERN = /\/p\/([A-Za-z0-9_-]+)/;
const PHONE = '+14025550101';
const NOT_READY = "The signed copy isn't ready yet.";
const META = { attempt: 1, lastAttempt: false };
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** A signature cannot be edited through app_tenant (Ruling EQ), so fixtures change its image hash as the database owner. */
async function setDrawnHashAsOwner(proposalId: string, hash: string): Promise<void> {
  const owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  await owner.connect();
  try {
    await owner.query('update proposal_signatures set drawn_signature_png_sha256 = $1 where proposal_id = $2', [hash, proposalId]);
  } finally {
    await owner.end();
  }
}
// A 1x1 PNG, raw base64 as the sign route takes it.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const USER_AGENT = 'TestAgent/1.0';

const hasImage = (bytes: Uint8Array): boolean => Buffer.from(bytes).toString('latin1').includes('/Subtype /Image');

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(DAYTIME);
});

afterEach(async () => {
  await t.close();
});

/** A sent proposal, signed through the public route; the signed-pdf job is queued, not yet run. */
async function signed(email: string | null = 'molly@example.com', extra: { drawnSignature?: string } = {}, beforeSign?: (proposalId: string) => Promise<unknown>) {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
  const [m] = await inCompany(t, t.seed.a.companyId, (tx) =>
    tx
      .insert(measurements)
      .values({ companyId: t.seed.a.companyId, propertyId: property.id, jobId: job.id, kind: 'estimate', method: 'outline', surfaceSqFt: 2400, pitchX12: 6, edgeFt: 220, ridgeFt: 60, valleyFt: 20 })
      .returning({ id: measurements.id }),
  );
  await inCompany(t, t.seed.a.companyId, (tx) =>
    tx
      .update(customers)
      .set({ phones: [{ e164: PHONE, label: 'mobile', primary: true }], smsConsentStatus: 'express', emails: email === null ? [] : [email] })
      .where(eq(customers.id, customer.id)),
  );
  const made = await owner.post('/api/proposals').send({ measurementId: m!.id });
  expect(made.status).toBe(201);
  const proposal = made.body as ProposalView;
  const ask = await owner.post(`/api/proposals/${proposal.id}/send`);
  expect(ask.status).toBe(201);
  const taskId = ask.body.taskId as string;
  const approve = await owner.post(`/api/approvals/${taskId}/approve`).send(seenOf(await dbSteps(t, 'a', taskId)));
  expect(approve.status).toBe(200);
  await t.queue.drain(t.deps);
  const match = TOKEN_PATTERN.exec(t.sms.sent[0]!.body);
  expect(match).not.toBeNull();
  const token = match![1]!;
  if (beforeSign) await beforeSign(proposal.id);
  const view = (await request(t.app).get(`/api/public/proposals/${token}`)).body as PublicProposalView;
  const res = await request(t.app)
    .post(`/api/public/proposals/${token}/sign`)
    .set('Origin', t.deps.config.APP_ORIGIN)
    .set('User-Agent', USER_AGENT)
    .send({ optionId: view.options[1]?.id ?? view.options[0]!.id, consent: true, signerName: 'Molly Lindgren', typedSignature: 'Molly Lindgren', ...extra });
  expect(res.status).toBe(200);
  return { proposal, token };
}

const signatureRows = (proposalId: string) =>
  inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(proposalSignatures).where(eq(proposalSignatures.proposalId, proposalId)));
const fileRows = () => inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(storedFiles).where(eq(storedFiles.kind, 'signed_proposal_pdf')));
const run = (proposalId: string) => makeSignedPdf(t.deps, t.seed.a.companyId, proposalId, META);
/** The stored signed PDF's bytes (after the job ran). */
async function storedPdf(): Promise<Uint8Array> {
  const files = await fileRows();
  expect(files).toHaveLength(1);
  const bytes = await t.objectStore.get(files[0]!.objectKey);
  expect(bytes).not.toBeNull();
  return bytes!;
}
const pdfPuts = () => t.objectStore.calls.filter((c) => c.method === 'put' && c.key.endsWith('.pdf'));
const signedEvent = async (proposalId: string) =>
  (await inCompany(t, t.seed.a.companyId, (tx) =>
    tx.select().from(proposalEvents).where(and(eq(proposalEvents.proposalId, proposalId), eq(proposalEvents.kind, 'signed'))),
  ))[0]!;

/** A 4x2 RGBA PNG whose image data is not zlib: png-js's async decode threw it out of the process (review A-C1). */
function corruptPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([magic, chunk('IHDR', ihdr), chunk('IDAT', Buffer.from('notzlibdata')), chunk('IEND', Buffer.alloc(0))]);
}

// A renderer fixture: one signed estimate-based option.
const calculation = calculateQuote({ ...defaultScope, areaSqFt: 2400, areaType: 'surface', pitch: 6 }, defaultPricebook);
const fixtureProposal = {
  id: 'p1', number: 'P-0001', status: 'signed', jobId: 'j1', customer: { id: 'c1', name: 'Molly Lindgren', phone: null },
  address: '100 Oak St, Omaha, NE', measurementId: 'm1', basis: 'estimate',
  options: [{ id: 'opt-better', tier: 'better', name: 'Bravo Shingles', highlights: [], scope: { ...defaultScope }, addOns: [], calculation, addOnLines: [], totalCents: 1_234_500, monthlyEstimateCents: null, enabled: true }],
  messageBody: 'Hi', validUntil: '2026-11-11', sentAt: null, views: { count: 0, first: null, last: null },
  signed: null, declined: null, taskId: null, replacedById: null, canEdit: false,
} as unknown as ProposalView;
const fixtureRecord: SignatureRecord = {
  optionId: 'opt-better', signerName: 'Molly Q. Lindgren', typedSignature: 'Molly Q. Lindgren', drawnSignaturePngSha256: null,
  consentText: 'I agree to sign electronically.', consentVersion: 'v1', documentSha256: 'ab12'.repeat(16), totalCents: 1_234_500,
  ip: '203.0.113.9', userAgent: USER_AGENT, signedAt: '2026-10-12T15:00:00.000Z', viewedFirstAt: null,
};
const renderFixture = (o: { image?: Buffer | null; record?: Partial<SignatureRecord>; compress?: boolean } = {}) =>
  pdfToBuffer(
    renderProposalPdf(
      {
        audience: 'homeowner',
        company: { name: 'Acme Roofing', phone: null },
        proposal: fixtureProposal,
        estimateClause: ESTIMATE_CLAUSE_V1,
        signature: { record: { ...fixtureRecord, ...o.record }, image: o.image ?? null, timeZone: 'America/Chicago' },
      },
      { compress: o.compress ?? true },
    ),
  );

describe('signed pdf job', () => {
  test('stores the signed PDF whose sha256 matches its bytes', async () => {
    const s = await signed();
    await t.jobs.drain(t.deps);
    const [sig] = await signatureRows(s.proposal.id);
    expect(sig!.pdfFileId).not.toBeNull();
    expect(sig!.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    const files = await fileRows();
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe(sig!.pdfFileId);
    expect(files[0]!.sha256).toBe(sig!.pdfSha256);
    expect(files[0]!.objectKey).toBe(`companies/${t.seed.a.companyId}/proposals/${s.proposal.id}/signed-${sig!.pdfSha256}.pdf`);
    const bytes = await t.objectStore.get(files[0]!.objectKey);
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(sha256(bytes!)).toBe(sig!.pdfSha256);
    expect(files[0]!.bytes).toBe(bytes!.length);
  });

  test('the PDF text contains the signer name, the consent text, the document hash and the estimate clause', async () => {
    const text = pdfText(await renderFixture({ compress: false }));
    expect(text).toContain('Molly Q. Lindgren');
    expect(text).toContain('I agree to sign electronically');
    expect(text).toContain('ab12'.repeat(16));
    expect(text).toContain(ESTIMATE_CLAUSE_V1);
  });

  test('the audit page shows the signer, the zoned time, the ip, the user agent, first viewed, the consent version and the document hash', async () => {
    const text = pdfText(await renderFixture());
    const audit = text.slice(text.indexOf('Signing record'));
    expect(text).toContain('Signing record');
    expect(audit).toContain('Signer: Molly Q. Lindgren');
    expect(audit).toContain('Typed signature: Molly Q. Lindgren');
    expect(audit).toContain('Signed at: October 12, 2026, 10:00 AM CDT (America/Chicago)');
    expect(audit).toContain('IP address: 203.0.113.9');
    expect(audit).toContain(`Device (user agent): ${USER_AGENT}`);
    expect(audit).toContain('First viewed: not recorded');
    expect(audit).toContain('Consent (version v1) I agree to sign electronically.');
    expect(audit).toContain(`Document SHA-256 ${'ab12'.repeat(16)}`);
    const viewed = pdfText(await renderFixture({ record: { viewedFirstAt: '2026-10-11T23:30:00.000Z' } }));
    expect(viewed).toContain('First viewed: October 11, 2026, 6:30 PM CDT (America/Chicago)');
  });

  test('the same signature renders the same bytes', async () => {
    const image = Buffer.from(TINY_PNG, 'base64');
    const first = await renderFixture({ image });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await renderFixture({ image });
    expect(Buffer.compare(first, second)).toBe(0);
  });

  test('the drawn signature is embedded once, though both pages show it (one async decode keeps the bytes stable)', async () => {
    const raw = Buffer.from(await renderFixture({ image: Buffer.from(TINY_PNG, 'base64'), compress: false })).toString('latin1');
    // An RGBA PNG is one image plus its alpha mask.
    expect(raw.match(/\/Subtype \/Image/g)).toHaveLength(2);
  });

  test('the job prints the estimate clause and the audit page when the setting is on and the basis is estimate', async () => {
    const s = await signed();
    await run(s.proposal.id);
    const text = pdfText(await storedPdf());
    expect(text).toContain(ESTIMATE_CLAUSE_V1);
    const [company] = await inCompany(t, t.seed.a.companyId, (tx) => tx.select({ zone: companies.timezone }).from(companies).where(eq(companies.id, t.seed.a.companyId)));
    const audit = text.slice(text.indexOf('Signing record'));
    expect(audit).toContain('Signer: Molly Lindgren');
    expect(audit).toMatch(new RegExp(`Signed at: [A-Z][a-z]+ \\d{1,2}, \\d{4}, \\d{1,2}:\\d{2} [AP]M \\S+ \\(${company!.zone.replace('/', '\\/')}\\)`));
    expect(audit).toContain(`Device (user agent): ${USER_AGENT}`);
    const [sig] = await signatureRows(s.proposal.id);
    expect(audit).toContain(`IP address: ${sig!.ip}`);
    expect(audit).toContain(`Consent (version ${sig!.consentVersion})`);
    expect(audit).toContain(`Document SHA-256 ${sig!.documentSha256}`);
    expect(audit).toContain('Drawn signature: none');
  });

  test('the job leaves the estimate clause out when the setting is off', async () => {
    await inCompany(t, t.seed.a.companyId, (tx) => tx.update(companySettings).set({ estimateChangeClause: false }).where(eq(companySettings.companyId, t.seed.a.companyId)));
    const s = await signed();
    await run(s.proposal.id);
    const text = pdfText(await storedPdf());
    expect(text).toContain('Signing record');
    expect(text).not.toContain(ESTIMATE_CLAUSE_V1);
  });

  test('the job leaves the estimate clause out when the basis is exact', async () => {
    const s = await signed('molly@example.com', {}, (id) =>
      inCompany(t, t.seed.a.companyId, (tx) => tx.update(proposals).set({ estimateBasis: 'exact' }).where(eq(proposals.id, id))),
    );
    await run(s.proposal.id);
    const text = pdfText(await storedPdf());
    expect(text).toContain('Signing record');
    expect(text).not.toContain(ESTIMATE_CLAUSE_V1);
  });

  test('the job draws the stored drawn signature after checking its hash', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const s = await signed('molly@example.com', { drawnSignature: TINY_PNG });
    const key = drawnSignatureKey(t.seed.a.companyId, s.proposal.id, sha256(png));
    expect(await t.objectStore.get(key)).not.toBeNull();
    await run(s.proposal.id);
    const bytes = await storedPdf();
    expect(hasImage(bytes)).toBe(true);
    expect(pdfText(bytes)).not.toContain('Drawn signature: none');
  });

  test('a drawn signature whose stored image does not match its hash fails the job and stores no PDF', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const s = await signed('molly@example.com', { drawnSignature: TINY_PNG });
    const key = drawnSignatureKey(t.seed.a.companyId, s.proposal.id, sha256(png));
    await t.objectStore.put(key, Buffer.concat([png, Buffer.from([0])]), 'image/png');
    await expect(run(s.proposal.id)).rejects.toThrow('does not match');
    expect(pdfPuts()).toHaveLength(0);
    expect(await fileRows()).toHaveLength(0);
    const [sig] = await signatureRows(s.proposal.id);
    expect(sig!.pdfFileId).toBeNull();
    expect(t.mailer.sent).toHaveLength(0);
  });

  test('a drawn signature whose image is missing fails the job and stores no PDF', async () => {
    const s = await signed('molly@example.com', { drawnSignature: TINY_PNG });
    await setDrawnHashAsOwner(s.proposal.id, sha256(Buffer.from('never stored')));
    await expect(run(s.proposal.id)).rejects.toThrow('missing');
    expect(pdfPuts()).toHaveLength(0);
    expect(await fileRows()).toHaveLength(0);
    const [sig] = await signatureRows(s.proposal.id);
    expect(sig!.pdfFileId).toBeNull();
  });

  test('a stored drawn image that is not a drawable PNG fails the job cleanly (no crash) and stores no PDF', async () => {
    const s = await signed('molly@example.com', { drawnSignature: TINY_PNG });
    const bad = corruptPng();
    // As if a bad image had been stored before the sign route checked images in full.
    await t.objectStore.put(drawnSignatureKey(t.seed.a.companyId, s.proposal.id, sha256(bad)), bad, 'image/png');
    await setDrawnHashAsOwner(s.proposal.id, sha256(bad));
    await expect(run(s.proposal.id)).rejects.toThrow('not a PNG this app can draw');
    // Give any stray async decode a chance to throw (it would fail the run as an unhandled error).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pdfPuts()).toHaveLength(0);
    expect(await fileRows()).toHaveLength(0);
    const [sig] = await signatureRows(s.proposal.id);
    expect(sig!.pdfFileId).toBeNull();
  });

  test('the PDF prints the signed facts from the stored document, whatever changes after signing', async () => {
    const companyId = t.seed.a.companyId;
    await inCompany(t, companyId, async (tx) => {
      await tx.update(companies).set({ phoneE164: '+14025550111' }).where(eq(companies.id, companyId));
      await tx.update(companySettings).set({ financingAprBps: 999, financingTermMonths: 120, estimateChangeClause: true }).where(eq(companySettings.companyId, companyId));
    });
    const s = await signed();
    // After signing: a new phone, a new name, new financing and the clause off.
    await inCompany(t, companyId, async (tx) => {
      await tx.update(companies).set({ phoneE164: '+14025550999', name: 'Renamed Roofing Co' }).where(eq(companies.id, companyId));
      await tx.update(companySettings).set({ financingAprBps: 799, financingTermMonths: 60, estimateChangeClause: false }).where(eq(companySettings.companyId, companyId));
    });
    await run(s.proposal.id);
    const text = pdfText(await storedPdf());
    expect(text).toContain('+14025550111');
    expect(text).not.toContain('+14025550999');
    expect(text).not.toContain('Renamed Roofing Co');
    expect(text).toContain(ESTIMATE_CLAUSE_V1);
    const signingPage = text.slice(text.indexOf('Signed by'), text.indexOf('Signing record'));
    expect(signingPage).toContain('9.99% for 120 months');
    expect(signingPage).not.toContain('7.99%');

    // The stored document is the one hashed, and it holds the signed values.
    const [sig] = await signatureRows(s.proposal.id);
    const document = (await signedEvent(s.proposal.id)).data['document'] as { company: { phone: string | null }; option: { financingTerms: unknown; totalCents: number } };
    expect(createHash('sha256').update(canonicalJson(document)).digest('hex')).toBe(sig!.documentSha256);
    expect(document.company.phone).toBe('+14025550111');
    expect(document.option.financingTerms).toEqual({ aprBps: 999, months: 120 });
    expect(document.option.totalCents).toBe(sig!.totalCents);
  });

  test('the sweep queues the job again for a signature over 10 minutes old with no PDF, once per proposal', async () => {
    const s = await signed();
    const signedAt = t.clock.now();
    // Its own job is still waiting (or its retries ran out): too early to sweep.
    expect(await sweepSignedPdfs(t.deps, new Date(signedAt.getTime() + SIGNED_PDF_GRACE_MS - 60_000))).toEqual({ queued: 0 });
    const later = new Date(signedAt.getTime() + SIGNED_PDF_GRACE_MS + 60_000);
    expect(await sweepSignedPdfs(t.deps, later)).toEqual({ queued: 1 });
    const sends = t.jobs.sent.filter((j) => j.name === 'signed-pdf');
    expect(sends.at(-1)).toEqual({ name: 'signed-pdf', data: { companyId: t.seed.a.companyId, proposalId: s.proposal.id }, singletonKey: s.proposal.id });
    await t.jobs.drain(t.deps);
    expect(await fileRows()).toHaveLength(1);
    // Made: nothing left to sweep.
    expect(await sweepSignedPdfs(t.deps, later)).toEqual({ queued: 0 });
  });

  test('is idempotent: a second run does not duplicate the file or the email', async () => {
    const s = await signed();
    await run(s.proposal.id);
    await run(s.proposal.id);
    expect(await fileRows()).toHaveLength(1);
    expect(t.mailer.sent).toHaveLength(1);
  });

  test('GET /api/public/proposals/:token/signed.pdf streams the stored bytes', async () => {
    const s = await signed();
    const before = await request(t.app).get(`/api/public/proposals/${s.token}/signed.pdf`);
    expect(before.status).toBe(404);
    expect(before.body.error).toBe(NOT_READY);
    await t.jobs.drain(t.deps);
    const [file] = await fileRows();
    const stored = await t.objectStore.get(file!.objectKey);
    const res = await request(t.app).get(`/api/public/proposals/${s.token}/signed.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(Buffer.compare(res.body as Buffer, Buffer.from(stored!))).toBe(0);
  });

  test('emails the link once when the customer has an email, and not when there is none', async () => {
    const s = await signed();
    await run(s.proposal.id);
    await run(s.proposal.id);
    expect(t.mailer.sent).toHaveLength(1);
    const mail = t.mailer.sent[0]!;
    expect(mail.to).toBe('molly@example.com');
    expect(mail.subject).toMatch(/^Your signed roof agreement with .+/);
    expect(mail.text).toContain(`/api/public/proposals/${s.token}/signed.pdf`);
    expect(Object.keys(mail).sort()).toEqual(['subject', 'text', 'to']);
  });

  test('sends no email when the customer has none', async () => {
    const s = await signed(null);
    await run(s.proposal.id);
    expect(await fileRows()).toHaveLength(1);
    expect(t.mailer.sent).toHaveLength(0);
  });

  test('a store failure is retried and leaves the signature row untouched', async () => {
    const s = await signed();
    t.objectStore.failNext(1);
    await expect(run(s.proposal.id)).rejects.toThrow();
    const [sig] = await signatureRows(s.proposal.id);
    expect(sig!.pdfFileId).toBeNull();
    expect(await fileRows()).toHaveLength(0);
    await run(s.proposal.id);
    const [after] = await signatureRows(s.proposal.id);
    expect(after!.pdfFileId).not.toBeNull();
    expect(await fileRows()).toHaveLength(1);
  });
});
