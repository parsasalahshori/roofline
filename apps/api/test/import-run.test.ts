import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import { auditLog, customers, imports, jobs, optOuts, properties } from '@roofline/db';
import { consentAttestationText } from '@roofline/shared';
import { runImport } from '../src/imports/run.ts';
import { dbAudit, inCompany } from './crm-helpers.ts';
import { buildImportFixture } from './fixtures/import-1000.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const FIXTURE = buildImportFixture();
const FAILED_PLAIN = "We couldn't finish this import. Rows already imported are saved. Try again from Setup.";
const CRASH_TRIGGER = 'test_import_crash_once';
const ALWAYS_FAILS_TRIGGER = 'test_import_always_fails';
const STAGE_HEADER = 'Name,Phone,Street Address,City,State,Zip,Stage';
const STAGE_MAPPING = { name: 0, phone: 1, street: 2, city: 3, state: 4, zip: 5, stage: 6 };
const NO_STAGE_MAPPING = { name: 0, phone: 1, street: 2, city: 3, state: 4, zip: 5 };
const ADDRESS_MAPPING = { name: 0, phone: 1, street: 2, city: 3, state: 4, zip: 5 };

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  await seedExisting(t);
});

const companyId = () => t.seed.a.companyId;

/** The 50 existing customers of Acme, with their consent, do-not-contact flags and opt-outs. */
async function seedExisting(app: TestApp): Promise<void> {
  const cid = app.seed.a.companyId;
  await inCompany(app, cid, async (tx) => {
    await tx.insert(customers).values(
      FIXTURE.existing.map((c) => ({
        companyId: cid,
        displayName: c.name,
        phones: [{ e164: c.phone, primary: true }],
        smsConsentStatus: c.consent,
        doNotContact: c.doNotContact,
      })),
    );
    const outs = FIXTURE.existing.filter((c) => c.optedOut);
    await tx.insert(optOuts).values(outs.map((c) => ({ companyId: cid, phoneE164: c.phone })));
  });
}

/** Uploads raw bytes the way the browser does: octet-stream, with the file name in the query. */
function upload(agent: SuperAgent, bytes: Buffer, fileName = 'customers.csv') {
  return agent
    .post(`/api/imports?fileName=${encodeURIComponent(fileName)}`)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
}

/** Uploads a CSV given as lines (the first line is the header) and returns the import id. */
async function uploadLines(owner: SuperAgent, lines: string[], fileName = 'customers.csv'): Promise<string> {
  const res = await upload(owner, Buffer.from(`${lines.join('\n')}\n`), fileName);
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

async function setMapping(owner: SuperAgent, id: string, mapping: Record<string, number>): Promise<void> {
  const res = await owner.patch(`/api/imports/${id}`).send({ mapping });
  if (res.status !== 200) throw new Error(`mapping failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function startImport(owner: SuperAgent, id: string, attested: boolean): Promise<void> {
  const body = attested
    ? { consentAttested: true, consentText: consentAttestationText(t.seed.a.name) }
    : { consentAttested: false };
  const res = await owner.post(`/api/imports/${id}/start`).send(body);
  if (res.status !== 202) throw new Error(`start failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function dbImport(id: string) {
  return inCompany(t, companyId(), async (tx) => (await tx.select().from(imports).where(eq(imports.id, id)))[0]!);
}

async function allCustomers() {
  return inCompany(t, companyId(), (tx) => tx.select().from(customers));
}

async function allJobs() {
  return inCompany(t, companyId(), (tx) => tx.select().from(jobs));
}

async function customerNamed(name: string) {
  const found = (await allCustomers()).find((c) => c.displayName === name);
  if (!found) throw new Error(`no customer named ${name}`);
  return found;
}

async function countCustomers(): Promise<number> {
  return inCompany(t, companyId(), async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(customers))[0]!.n);
}

async function countProperties(): Promise<number> {
  return inCompany(t, companyId(), async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(properties))[0]!.n);
}

async function countJobs(): Promise<number> {
  return inCompany(t, companyId(), async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(jobs))[0]!.n);
}

/** One Stage-column CSV with five rows at a unique phone and street block (base + i). */
function stageLines(base: number, namePrefix: string): string[] {
  const stages = ['Lead', 'Sold', 'Inspection', 'weird', ''];
  return [
    STAGE_HEADER,
    ...stages.map((stage, i) => {
      const n = i + 1;
      return `${namePrefix} ${n},(402) 555-${base + n},${base + n} Stage Rd,Omaha,NE,68102,${stage}`;
    }),
  ];
}

describe('customer import run', () => {
  test('the 1,000-row file gives the right new, updated and skipped counts', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;
    await startImport(owner, id, true);

    await t.jobs.drain(t.deps);

    const row = await dbImport(id);
    expect(row.status).toBe('done');
    expect(row.counts).toMatchObject({ new: 850, updated: 50, skipped: 100 });
    expect(await countCustomers()).toBe(900);
    expect(await countProperties()).toBe(900);
    expect(await countJobs()).toBe(0);
  });

  test('attested customers have a full consent record', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;
    await startImport(owner, id, true);

    await t.jobs.drain(t.deps);

    const c = await customerNamed('Customer 1');
    expect(c.smsConsentStatus).toBe('attested');
    expect(c.smsConsentSource).toBe('import');
    expect(c.smsConsentByUserId).toBe(t.seed.a.owner.userId);
    expect(c.smsConsentAt).toEqual(t.clock.now());
    expect(c.smsConsentEvidence).toEqual({ import_id: id, text: consentAttestationText('Acme Roofing') });
  });

  test('matched customers who were revoked, written or do-not-contact keep that status', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    await startImport(owner, created.body.id as string, true);

    await t.jobs.drain(t.deps);

    const all = await allCustomers();
    for (let k = 0; k < 30; k += 1) {
      const expected = FIXTURE.existing[k]!;
      const c = all.find((x) => x.displayName === expected.name)!;
      expect(c.smsConsentStatus).toBe(expected.consent);
      expect(c.doNotContact).toBe(expected.doNotContact);
    }
    expect(all.find((x) => x.displayName === 'Existing 25')!.doNotContact).toBe(true);
  });

  test('an unchecked import gives express only', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;
    await startImport(owner, id, false);

    await t.jobs.drain(t.deps);

    const row = await dbImport(id);
    expect(row.status).toBe('done');
    expect(row.consentAttested).toBe(false);
    expect((await allCustomers()).filter((c) => c.smsConsentStatus === 'attested')).toHaveLength(0);
    const c = await customerNamed('Customer 1');
    expect(c.smsConsentStatus).toBe('express');
    expect(c.smsConsentSource).toBe('import');
    expect(c.smsConsentByUserId).toBe(t.seed.a.owner.userId);
    expect(c.smsConsentEvidence).toEqual({ import_id: id });
  });

  test('jobs only when a stage column is mapped', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);

    const mappedId = await uploadLines(owner, stageLines(7000, 'Row'), 'stage.csv');
    await setMapping(owner, mappedId, STAGE_MAPPING);
    await startImport(owner, mappedId, false);
    await t.jobs.drain(t.deps);

    const mappedJobs = await allJobs();
    expect(mappedJobs).toHaveLength(4);
    for (const j of mappedJobs) expect(j.source).toBe('import');
    const names = new Map((await allCustomers()).map((c) => [c.id, c.displayName]));
    const stageByName = Object.fromEntries(mappedJobs.map((j) => [names.get(j.customerId), j.stage]));
    expect(stageByName).toEqual({ 'Row 1': 'lead', 'Row 2': 'won', 'Row 3': 'inspection', 'Row 4': 'lead' });

    // The same kind of file, with new homes, but Stage not mapped: no job at all.
    const unmappedId = await uploadLines(owner, stageLines(7100, 'Plain'), 'stage-unmapped.csv');
    await setMapping(owner, unmappedId, NO_STAGE_MAPPING);
    await startImport(owner, unmappedId, false);
    await t.jobs.drain(t.deps);

    expect((await dbImport(unmappedId)).counts).toMatchObject({ jobs: 0 });
    expect(await countJobs()).toBe(4);
  });

  test('addresses are placed on the map in batches', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    await startImport(owner, created.body.id as string, true);
    await t.jobs.drain(t.deps);

    expect(t.geocoder.batches.length).toBeGreaterThan(0);
    for (const batch of t.geocoder.batches) expect(batch.length).toBeLessThanOrEqual(250);

    const id = await uploadLines(
      owner,
      [
        'Name,Phone,Street Address,City,State,Zip',
        'Ann Map,(402) 555-9001,12 Outage Ave,Omaha,NE,68102',
        'Ben Map,(402) 555-9002,14 Maple St,Omaha,NE,68102',
        'Cal Map,(402) 555-9003,16 Maple St,Omaha,NE,68102',
      ],
      'map.csv',
    );
    await setMapping(owner, id, ADDRESS_MAPPING);
    await startImport(owner, id, false);
    await t.jobs.drain(t.deps);

    const row = await dbImport(id);
    expect(row.counts).toMatchObject({ located: 2, notLocated: 1 });
    const geoOf = (line: string) =>
      inCompany(t, companyId(), async (tx) =>
        (
          await tx
            .select({ isNull: sql<boolean>`${properties.geom} is null` })
            .from(properties)
            .where(eq(properties.addressLine, line))
        )[0]!.isNull,
      );
    expect(await geoOf('12 Outage Ave')).toBe(true);
    expect(await geoOf('14 Maple St')).toBe(false);
  });

  test('a crash halfway resumes without duplicates', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;
    await startImport(owner, id, true);

    // Owner connection for DDL. The sequence is the "fired once" marker: a sequence is not rolled
    // back with the aborted transaction, so the crash happens only on the first matching write.
    const ddl = new pg.Client({ connectionString: inject('dbUrls').owner });
    await ddl.connect();
    try {
      await ddl.query(`create sequence ${CRASH_TRIGGER}_seq`);
      await ddl.query(`create function ${CRASH_TRIGGER}() returns trigger language plpgsql security definer set search_path = public as $$
        begin
          if NEW.row_number > 252 and NEW.outcome in ('created', 'updated') then
            if nextval('${CRASH_TRIGGER}_seq') = 1 then
              raise exception 'simulated crash in the second chunk';
            end if;
          end if;
          return NEW;
        end $$`);
      await ddl.query(`create trigger ${CRASH_TRIGGER} before update on import_rows
        for each row execute function ${CRASH_TRIGGER}()`);

      await t.jobs.drain(t.deps);

      // The first attempt threw once, the retry ran to the end.
      expect(t.jobs.errors).toHaveLength(1);
      const row = await dbImport(id);
      expect(row.status).toBe('done');
      expect(row.counts).toMatchObject({ new: 850, updated: 50, skipped: 100 });
      expect(await countCustomers()).toBe(900);
      expect(await countProperties()).toBe(900);
    } finally {
      await ddl.query(`drop trigger if exists ${CRASH_TRIGGER} on import_rows`);
      await ddl.query(`drop function if exists ${CRASH_TRIGGER}()`);
      await ddl.query(`drop sequence if exists ${CRASH_TRIGGER}_seq`);
      await ddl.end();
    }
  });

  test('running it again does nothing', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;
    await startImport(owner, id, true);
    await t.jobs.drain(t.deps);

    const before = await dbImport(id);
    const customersBefore = await countCustomers();
    const propertiesBefore = await countProperties();

    await runImport(t.deps, companyId(), id, { attempt: 1, lastAttempt: false });

    expect(await countCustomers()).toBe(customersBefore);
    expect(await countProperties()).toBe(propertiesBefore);
    expect(await dbImport(id)).toEqual(before);
    expect(t.jobs.errors).toHaveLength(0);
  });

  test('the skipped-rows file lists every skipped row', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;
    await startImport(owner, id, true);
    await t.jobs.drain(t.deps);

    const res = await owner.get(`/api/imports/${id}/skipped.csv`);

    expect(res.status).toBe(200);
    const lines = res.text.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(101);
    expect(lines.some((l) => l.startsWith('902,Duplicate of row 2,'))).toBe(true);
  });

  test('the audit has the import and the consent confirmation', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;
    await startImport(owner, id, true);
    await t.jobs.drain(t.deps);

    const actions = new Set(
      (await inCompany(t, companyId(), (tx) => tx.select({ action: auditLog.action }).from(auditLog))).map((r) => r.action),
    );
    expect(actions.has('import.started')).toBe(true);
    expect(actions.has('import.consent_attested')).toBe(true);
    expect(actions.has('import.finished')).toBe(true);

    const attested = await dbAudit(t, companyId(), 'import.consent_attested');
    expect(attested).toHaveLength(1);
    expect(attested[0]!.after).toMatchObject({ importId: id });
  });

  test('the last failed attempt marks it failed with a plain reason', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, Buffer.from(FIXTURE.csv));
    const id = created.body.id as string;
    await startImport(owner, id, true);

    // Every customer write fails, so no chunk can land.
    const ddl = new pg.Client({ connectionString: inject('dbUrls').owner });
    await ddl.connect();
    try {
      await ddl.query(`create function ${ALWAYS_FAILS_TRIGGER}() returns trigger language plpgsql as $$
        begin raise exception 'simulated write failure'; end $$`);
      await ddl.query(`create trigger ${ALWAYS_FAILS_TRIGGER} before insert on customers
        for each row execute function ${ALWAYS_FAILS_TRIGGER}()`);

      await t.jobs.drain(t.deps);

      expect(t.jobs.errors).toHaveLength(5);
      const row = await dbImport(id);
      expect(row.status).toBe('failed');
      expect(row.errorPlain).toBe(FAILED_PLAIN);
    } finally {
      await ddl.query(`drop trigger if exists ${ALWAYS_FAILS_TRIGGER} on customers`);
      await ddl.query(`drop function if exists ${ALWAYS_FAILS_TRIGGER}()`);
      await ddl.end();
    }
  });
});
