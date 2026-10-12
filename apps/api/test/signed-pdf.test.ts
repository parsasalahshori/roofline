import { createHash } from 'node:crypto';
import type { ProposalView, PublicProposalView, SignatureRecord } from '@roofline/shared';
import { calculateQuote, defaultPricebook, defaultScope } from '@roofline/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { customers, measurements, proposalSignatures, storedFiles } from '@roofline/db';
import { makeSignedPdf } from '../src/estimator/signed-pdf.ts';
import { pdfToBuffer, renderProposalPdf } from '../src/proposals/pdf.ts';
import { addressFor, Actors, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
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

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(DAYTIME);
});

afterEach(async () => {
  await t.close();
});

/** A sent proposal, signed through the public route; the signed-pdf job is queued, not yet run. */
async function signed(email: string | null = 'molly@example.com') {
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
  const view = (await request(t.app).get(`/api/public/proposals/${token}`)).body as PublicProposalView;
  const res = await request(t.app)
    .post(`/api/public/proposals/${token}/sign`)
    .set('Origin', t.deps.config.APP_ORIGIN)
    .send({ optionId: view.options[1]?.id ?? view.options[0]!.id, consent: true, signerName: 'Molly Lindgren', typedSignature: 'Molly Lindgren' });
  expect(res.status).toBe(200);
  return { proposal, token };
}

const signatureRows = (proposalId: string) =>
  inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(proposalSignatures).where(eq(proposalSignatures.proposalId, proposalId)));
const fileRows = () => inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(storedFiles).where(eq(storedFiles.kind, 'signed_proposal_pdf')));
const run = (proposalId: string) => makeSignedPdf(t.deps, t.seed.a.companyId, proposalId, META);

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

  test('the PDF text contains the signer name, the consent text, the document hash and the Estimate clause when it is on', async () => {
    const calculation = calculateQuote({ ...defaultScope, areaSqFt: 2400, areaType: 'surface', pitch: 6 }, defaultPricebook);
    const proposal = {
      id: 'p1', number: 'P-0001', status: 'signed', jobId: 'j1', customer: { id: 'c1', name: 'Molly Lindgren', phone: null },
      address: '100 Oak St, Omaha, NE', measurementId: 'm1', basis: 'estimate',
      options: [{ id: 'opt-better', tier: 'better', name: 'Bravo Shingles', highlights: [], scope: { ...defaultScope }, addOns: [], calculation, addOnLines: [], totalCents: 1_234_500, monthlyEstimateCents: null, enabled: true }],
      messageBody: 'Hi', validUntil: '2026-11-11', sentAt: null, views: { count: 0, first: null, last: null },
      signed: null, declined: null, taskId: null, replacedById: null, canEdit: false,
    } as unknown as ProposalView;
    const record: SignatureRecord = {
      optionId: 'opt-better', signerName: 'Molly Q. Lindgren', typedSignature: 'Molly Q. Lindgren', drawnSignaturePngSha256: null,
      consentText: 'I agree to sign electronically.', consentVersion: 'v1', documentSha256: 'ab12'.repeat(16), totalCents: 1_234_500,
      ip: '1.1.1.1', userAgent: 'x', signedAt: '2026-10-12T15:00:00.000Z', viewedFirstAt: null,
    };
    const doc = renderProposalPdf({ audience: 'homeowner', company: { name: 'Acme Roofing', phone: null }, proposal, signature: { record, image: null } }, { compress: false });
    const raw = (await pdfToBuffer(doc)).toString('latin1');
    const hexText = [...raw.matchAll(/\[([^\]]*)\] TJ/g)]
      .map((m) => Buffer.from([...m[1]!.matchAll(/<([0-9a-f]*)>/g)].map((h) => h[1]).join(''), 'hex').toString('latin1'))
      .join('\n');
    const text = `${hexText}\n${raw}`;
    expect(text).toContain('Molly Q. Lindgren');
    expect(text).toContain('I agree to sign electronically');
    expect(text).toContain('ab12'.repeat(16));
    expect(text).toContain('Estimate');
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
