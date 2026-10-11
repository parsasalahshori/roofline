import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, test } from 'vitest';
import { customers, optOuts } from '@roofline/db';
import { consentAttestationText } from '@roofline/shared';
import { inCompany } from './crm-helpers.ts';
import { buildImportFixture } from './fixtures/import-1000.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const TOO_BIG = 'That file is too big. The most we can take is 10 MB.';
const WRONG_TYPE = 'Please upload a .csv or .xlsx file.';
const TOO_MANY = 'This file has more than 20,000 rows. Split it into smaller files and import each one.';
const ALREADY_STARTED = 'This import already started.';
const CONSENT_MISMATCH = 'Please confirm the consent statement as shown.';
const NOT_FINISHED = "This import isn't finished yet.";
const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NOT_FOUND = "We couldn't find that.";

const FIXTURE = buildImportFixture();
const DEFAULT_MAPPING = { name: 0, phone: 1, email: 2, street: 3, city: 4, state: 5, zip: 6, notes: 7 };
const WITHOUT_PHONE = { name: 0, email: 2, street: 3, city: 4, state: 5, zip: 6, notes: 7 };

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  await seedExisting(t);
});

/** The 50 existing customers of Acme, with their consent, do-not-contact flags and opt-outs. */
async function seedExisting(app: TestApp): Promise<void> {
  const companyId = app.seed.a.companyId;
  await inCompany(app, companyId, async (tx) => {
    await tx.insert(customers).values(
      FIXTURE.existing.map((c) => ({
        companyId,
        displayName: c.name,
        phones: [{ e164: c.phone, primary: true }],
        smsConsentStatus: c.consent,
        doNotContact: c.doNotContact,
      })),
    );
    const outs = FIXTURE.existing.filter((c) => c.optedOut);
    await tx.insert(optOuts).values(outs.map((c) => ({ companyId, phoneE164: c.phone })));
  });
}

/** Uploads raw bytes the way the browser does: octet-stream, with the file name in the query. */
function upload(agent: SuperAgent, bytes: Buffer, fileName = 'customers.csv') {
  return agent
    .post(`/api/imports?fileName=${encodeURIComponent(fileName)}`)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
}

describe('customer import API', () => {
  test('upload the 1,000-row file: auto-mapped, with exact counts and 20 preview rows', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await upload(owner, Buffer.from(FIXTURE.csv));

    expect(res.status).toBe(201);
    expect(res.body.rowCount).toBe(1000);
    expect(res.body.counts.new).toBe(850);
    expect(res.body.counts.updated).toBe(50);
    expect(res.body.counts.skipped).toBe(100);
    expect(res.body.preview).toHaveLength(20);
    expect(res.body.mapping).toEqual(DEFAULT_MAPPING);
  });

  test('the checked preview shows the consent outcome', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));

    const res = await owner.get(`/api/imports/${created.body.id}?attested=true`);

    expect(res.status).toBe(200);
    expect(res.body.counts.consent).toEqual({ attested: 870, express: 0, unchanged: 10, optedOutKept: 20 });
  });

  test('changing the mapping changes the preview', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));

    const res = await owner.patch(`/api/imports/${created.body.id}`).send({ mapping: WITHOUT_PHONE });

    expect(res.status).toBe(200);
    expect(res.body.counts.skippedBy).toEqual({ noName: 15, noContact: 985, badPhone: 0, duplicate: 0 });
  });

  test('start queues one job, even when clicked twice', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;
    const body = { consentAttested: true, consentText: consentAttestationText(t.seed.a.name) };

    const first = await owner.post(`/api/imports/${id}/start`).send(body);
    const second = await owner.post(`/api/imports/${id}/start`).send(body);

    expect(first.status).toBe(202);
    expect(first.body.status).toBe('queued');
    expect(second.status).toBe(409);
    expect(second.body.error).toBe(ALREADY_STARTED);
    expect(t.jobs.sent).toHaveLength(1);
    expect(t.jobs.sent[0]).toMatchObject({ name: 'import-customers', data: { importId: id } });

    const after = await owner.get(`/api/imports/${id}`);
    expect(after.body.status).toBe('queued');
  });

  test('the consent statement must match', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;

    const res = await owner
      .post(`/api/imports/${id}/start`)
      .send({ consentAttested: true, consentText: 'I agree.' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: CONSENT_MISMATCH, field: 'consentText' });
  });

  test('office and reps cannot import; company B cannot see it', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const office = await loginAs(t.app, t.seed.a.office);
    const rep = await loginAs(t.app, t.seed.a.rep);
    const otherOwner = await loginAs(t.app, t.seed.b.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;

    const officeUpload = await upload(office, Buffer.from(FIXTURE.csv));
    const repUpload = await upload(rep, Buffer.from(FIXTURE.csv));
    const repView = await rep.get(`/api/imports/${id}`);
    const otherView = await otherOwner.get(`/api/imports/${id}`);

    expect(officeUpload.status).toBe(403);
    expect(officeUpload.body.error).toBe(NOT_ALLOWED);
    expect(repUpload.status).toBe(403);
    expect(repView.status).toBe(403);
    expect(otherView.status).toBe(404);
    expect(otherView.body.error).toBe(NOT_FOUND);
  });

  test('too big, wrong type, too many rows', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);

    const big = await upload(owner, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: TOO_BIG });

    const pdf = await upload(owner, Buffer.from('%PDF-1.4'), 'x.pdf');
    expect(pdf.status).toBe(400);
    expect(pdf.body).toEqual({ error: WRONG_TYPE, field: 'file' });

    const rows = ['Name,Phone', ...Array.from({ length: 20_001 }, (_, i) => `Customer ${i},(402) 555-0100`)];
    const tooMany = await upload(owner, Buffer.from(rows.join('\n')));
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toEqual({ error: TOO_MANY, field: 'file' });
  });

  test('an Excel file uploads too', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Customers');
    sheet.addRow(['Name', 'Phone', 'Email']);
    sheet.addRow(['Ann Lee', '(402) 555-7001', 'ann@example.com']);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const res = await upload(owner, bytes, 'customers.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.headers).toEqual(['Name', 'Phone', 'Email']);
  });

  test('skipped rows only after it finishes', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));

    const res = await owner.get(`/api/imports/${created.body.id}/skipped.csv`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(NOT_FINISHED);
  });
});
