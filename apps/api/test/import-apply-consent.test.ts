import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyImportChunk,
  customers,
  lockRecipients,
  optOuts,
  revokeConsentByText,
  withTenant,
  type ChunkWrite,
  type TenantContext,
  type Tx,
} from '@roofline/db';
import type { NormalizedRow } from '@roofline/shared';
import { dbCustomer, inCompany } from './crm-helpers.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
const NOW = new Date('2026-03-01T12:00:00Z');
const companyId = () => t.seed.a.companyId;
const ctx = (): TenantContext => ({ companyId: companyId(), userId: null, role: 'system', canApproveSpend: false });

beforeEach(async () => {
  t = await makeTestApp();
});

const P1 = '+14025550101';
const P2 = '+14025550102';
const P3 = '+14025550103';
const P4 = '+14025550104';
const P5 = '+14025550105';
const P6 = '+14025550106';

function normalized(over: Partial<NormalizedRow>): NormalizedRow {
  return {
    displayName: 'Row Person',
    firstName: null,
    lastName: null,
    phones: [],
    emails: [],
    address: null,
    notes: null,
    stage: null,
    ...over,
  };
}

/** Uploads a CSV with `n` data rows (numbered 2..n+1) so the import and its rows exist. */
async function makeImport(n: number): Promise<string> {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const lines = ['Name,Phone', ...Array.from({ length: n }, (_, i) => `Row ${i + 1},(402) 555-09${10 + i}`)];
  const res = await owner
    .post('/api/imports?fileName=customers.csv')
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from(`${lines.join('\n')}\n`));
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

function chunk(importId: string, rows: NormalizedRow[]): ChunkWrite {
  return {
    rows: rows.map((normalized, i) => ({
      rowNumber: i + 2,
      normalized,
      match: null,
      consent: 'none',
      consentChanged: false,
      geo: null,
    })),
    createJobs: false,
    fileName: 'customers.csv',
    attested: null,
    importId,
    createdByUserId: null,
  };
}

async function seedCustomer(values: Partial<typeof customers.$inferInsert> & { displayName: string }): Promise<string> {
  return inCompany(t, companyId(), async (tx) => {
    const [row] = await tx.insert(customers).values({ companyId: companyId(), ...values }).returning({ id: customers.id });
    return row!.id;
  });
}

async function stop(tx: Tx, phone: string, customerId: string): Promise<void> {
  await revokeConsentByText(
    tx,
    ctx(),
    { phoneE164: phone, keyword: 'stop', customerIds: [customerId], messageId: 'msg-test' },
    NOW,
  );
}

const optOutRow = (phone: string) =>
  inCompany(t, companyId(), async (tx) =>
    (await tx.select().from(optOuts).where(and(eq(optOuts.companyId, companyId()), eq(optOuts.phoneE164, phone))))[0],
  );

describe('import chunk consent', () => {
  test('import after a committed STOP leaves the customer revoked', async () => {
    const c = await seedCustomer({
      displayName: 'Cora',
      phones: [{ e164: P1, primary: true }, { e164: P2, primary: false }],
    });
    await inCompany(t, companyId(), (tx) => stop(tx, P2, c));
    const importId = await makeImport(1);

    await inCompany(t, companyId(), (tx) =>
      applyImportChunk(tx, ctx(), chunk(importId, [normalized({ phones: [P1] })]), NOW),
    );

    const row = await dbCustomer(t, companyId(), c);
    expect(row.smsConsentStatus).toBe('revoked');
    expect(row.smsConsentSource).toBe('text');
  });

  test('a chunk waits for an uncommitted STOP and then leaves the customer revoked', async () => {
    const c = await seedCustomer({
      displayName: 'Cora',
      phones: [{ e164: P1, primary: true }, { e164: P2, primary: false }],
    });
    const importId = await makeImport(1);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const lockedA = new Promise<void>((r) => {
      locked = r;
    });
    const txA = withTenant(t.deps.pools, ctx(), async (tx) => {
      await lockRecipients(tx, ctx(), [c]);
      await stop(tx, P2, c);
      locked();
      await gate;
    });
    await lockedA;

    let bDone = false;
    const txB = withTenant(t.deps.pools, ctx(), (tx) =>
      applyImportChunk(tx, ctx(), chunk(importId, [normalized({ phones: [P1] })]), NOW),
    ).then(() => {
      bDone = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(bDone).toBe(false);

    release();
    await txA;
    await txB;

    const row = await dbCustomer(t, companyId(), c);
    expect(row.smsConsentStatus).toBe('revoked');
    expect(row.smsConsentSource).toBe('text');
  });

  test('numbers an import adds to an opted-out customer go on the opt-out list', async () => {
    const a = await seedCustomer({
      displayName: 'Alma',
      phones: [{ e164: P1, primary: true }],
      emails: ['alma@example.com'],
      doNotContact: true,
    });
    const c = await seedCustomer({
      displayName: 'Carl',
      phones: [{ e164: P3, primary: true }],
      emails: ['carl@example.com'],
      smsConsentStatus: 'revoked',
    });
    await inCompany(t, companyId(), (tx) =>
      tx.insert(optOuts).values([
        { companyId: companyId(), phoneE164: P1 },
        { companyId: companyId(), phoneE164: P3 },
      ]),
    );
    const importId = await makeImport(2);

    await inCompany(t, companyId(), (tx) =>
      applyImportChunk(
        tx,
        ctx(),
        chunk(importId, [
          normalized({ emails: ['alma@example.com'], phones: [P2] }),
          normalized({ emails: ['carl@example.com'], phones: [P4] }),
        ]),
        NOW,
      ),
    );

    expect((await optOutRow(P2))?.keyword).toBe('manual');
    expect((await optOutRow(P4))?.keyword).toBe('manual');
    expect((await dbCustomer(t, companyId(), a)).doNotContact).toBe(true);
    expect((await dbCustomer(t, companyId(), c)).smsConsentStatus).toBe('revoked');
  });

  test('a customer who is only opted out by number does not list the numbers an import adds', async () => {
    const c = await seedCustomer({
      displayName: 'Nina',
      phones: [{ e164: P5, primary: true }],
      emails: ['nina@example.com'],
      smsConsentStatus: 'none',
    });
    await inCompany(t, companyId(), (tx) =>
      tx.insert(optOuts).values({ companyId: companyId(), phoneE164: P5, keyword: 'stop' }),
    );
    const importId = await makeImport(1);

    await inCompany(t, companyId(), (tx) =>
      applyImportChunk(tx, ctx(), chunk(importId, [normalized({ emails: ['nina@example.com'], phones: [P6] })]), NOW),
    );

    expect((await dbCustomer(t, companyId(), c)).phones.map((p) => p.e164)).toContain(P6);
    expect(await optOutRow(P6)).toBeUndefined();
  });
});
