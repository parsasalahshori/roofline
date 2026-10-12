import pg from 'pg';
import { asc } from 'drizzle-orm';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import { CUSTOMER_EXPORT_HEADERS, customers, JOB_EXPORT_HEADERS } from '@roofline/db';
import { localDate } from '@roofline/shared';
import { Actors, addressFor, dbAudit, dbCustomer, dbJob, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
});

const A = () => t.seed.a.companyId;

type Agent = Awaited<ReturnType<Actors['as']>>;

/** The company zone of the seeded companies (`companies.timezone`). */
const ZONE = 'America/Chicago';
const CUSTOMER_FILE = /^attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"$/;
const JOB_FILE = /^attachment; filename="jobs-\d{4}-\d{2}-\d{2}\.csv"$/;

const exportFile = (agent: Agent, file: 'customers' | 'jobs') => agent.get(`/api/export/${file}.csv`);

/** The lines of a CSV body: the header, then one line per row, then the empty string after the final CRLF. */
const linesOf = (text: string): string[] => text.split('\r\n');

/** Sets company A's status with the owner role (the app role cannot change it). */
async function setStatus(status: 'active' | 'past_due' | 'trial_ended' | 'canceled'): Promise<void> {
  const owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  await owner.connect();
  try {
    await owner.query('update companies set status = $1 where id = $2', [status, t.seed.a.companyId]);
  } finally {
    await owner.end();
  }
}

/** Maria Lopez at 1200 Pine St with one job in inspection, worth $12,000. */
async function maria(agent: Agent) {
  const customer = await mustCreate(agent, '/api/customers', {
    displayName: 'Maria Lopez',
    firstName: 'Maria',
    lastName: 'Lopez',
    phones: [{ number: '(402) 555-0142', primary: true }, { number: '402-555-0100' }],
    emails: ['maria@example.com', 'm.lopez@example.com'],
    tags: ['storm'],
  });
  const property = await mustCreate(agent, '/api/properties', {
    customerId: customer.id,
    addressLine: '1200 Pine St',
    city: 'Omaha',
    state: 'NE',
    zip: '68102',
  });
  const job = await mustCreate(agent, '/api/jobs', {
    customerId: customer.id,
    propertyId: property.id,
    stage: 'inspection',
    valueCents: 1200000,
  });
  return { customer, property, job };
}

describe('CSV export', () => {
  test('headers and one row each are exact', async () => {
    const owner = await who.as('owner');
    const m = await maria(owner);
    const savedCustomer = await dbCustomer(t, A(), m.customer.id);
    const savedJob = await dbJob(t, A(), m.job.id);

    const customerRow = [
      'Maria Lopez',
      'Maria',
      'Lopez',
      // Phones start with +, so the formula guard prefixes an apostrophe.
      "'+14025550142",
      "'+14025550100",
      'maria@example.com',
      'm.lopez@example.com',
      '1200 Pine St',
      'Omaha',
      'NE',
      '68102',
      'not asked',
      'No',
      'storm',
      'manual',
      localDate(savedCustomer.createdAt, ZONE),
      'No',
    ];
    const jobRow = [
      'Maria Lopez',
      '1200 Pine St',
      'Omaha',
      'NE',
      '68102',
      'Inspection',
      '12000.00',
      '',
      'manual',
      '',
      '',
      '',
      localDate(savedJob.stageChangedAt, ZONE),
      localDate(savedJob.createdAt, ZONE),
      'No',
    ];

    const customerFile = await exportFile(owner, 'customers');
    expect(customerFile.status).toBe(200);
    expect(customerFile.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(customerFile.headers['content-disposition']).toMatch(CUSTOMER_FILE);
    expect(linesOf(customerFile.text)).toEqual([CUSTOMER_EXPORT_HEADERS.join(','), customerRow.join(','), '']);

    const jobFile = await exportFile(owner, 'jobs');
    expect(jobFile.status).toBe(200);
    expect(jobFile.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(jobFile.headers['content-disposition']).toMatch(JOB_FILE);
    expect(linesOf(jobFile.text)).toEqual([JOB_EXPORT_HEADERS.join(','), jobRow.join(','), '']);
  });

  test('a name that starts with a formula is neutralized', async () => {
    const owner = await who.as('owner');
    await mustCreate(owner, '/api/customers', { displayName: '=HYPERLINK("x")' });

    const res = await exportFile(owner, 'customers');
    expect(res.status).toBe(200);
    // Quote doubling inside the cell, and a leading apostrophe so a spreadsheet reads text, not a formula.
    expect(linesOf(res.text)[1]!.startsWith('"\'=HYPERLINK(""x"")",')).toBe(true);
    expect(res.text).not.toMatch(/(^|,)=/m);
  });

  test('archived customers and jobs are included with Archived Yes', async () => {
    const owner = await who.as('owner');
    const m = await maria(owner);
    expect((await owner.post(`/api/customers/${m.customer.id}/archive`).send()).status).toBe(200);
    expect((await owner.post(`/api/jobs/${m.job.id}/archive`).send()).status).toBe(200);

    const customerLines = linesOf((await exportFile(owner, 'customers')).text);
    expect(customerLines).toHaveLength(3);
    expect(customerLines[1]!.split(',')[0]).toBe('Maria Lopez');
    expect(customerLines[1]!.endsWith(',Yes')).toBe(true);

    const jobLines = linesOf((await exportFile(owner, 'jobs')).text);
    expect(jobLines).toHaveLength(3);
    expect(jobLines[1]!.split(',')[0]).toBe('Maria Lopez');
    expect(jobLines[1]!.endsWith(',Yes')).toBe(true);
  });

  test('a rep is refused on both files; an office user gets both', async () => {
    const owner = await who.as('owner');
    await maria(owner);

    const rep = await who.as('rep');
    for (const file of ['customers', 'jobs'] as const) {
      const refused = await exportFile(rep, file);
      expect(refused.status, file).toBe(403);
      expect(refused.headers['content-type'] ?? '', file).not.toMatch(/csv/);
    }

    const office = await who.as('office');
    for (const file of ['customers', 'jobs'] as const) {
      const res = await exportFile(office, file);
      expect(res.status, file).toBe(200);
      expect(res.text, file).toContain('Maria Lopez');
    }
  });

  test("another company's customers and jobs are absent", async () => {
    const ownerB = await who.as('owner', 'b');
    const bCustomer = await mustCreate(ownerB, '/api/customers', { displayName: 'Bravo Only Customer' });
    const bProperty = await mustCreate(ownerB, '/api/properties', { customerId: bCustomer.id, ...addressFor(1) });
    await mustCreate(ownerB, '/api/jobs', { customerId: bCustomer.id, propertyId: bProperty.id });

    const ownerA = await who.as('owner');
    await mustCreate(ownerA, '/api/customers', { displayName: 'Alpha Customer' });

    const aCustomers = await exportFile(ownerA, 'customers');
    expect(aCustomers.status).toBe(200);
    expect(aCustomers.text).toContain('Alpha Customer');
    expect(aCustomers.text).not.toContain('Bravo Only Customer');

    const aJobs = await exportFile(ownerA, 'jobs');
    expect(aJobs.status).toBe(200);
    expect(aJobs.text).not.toContain('Bravo Only Customer');

    // Company B sees its own rows, so the absence above is about the tenant, not an empty file.
    const bCustomers = await exportFile(ownerB, 'customers');
    expect(bCustomers.text).toContain('Bravo Only Customer');
    expect(bCustomers.text).not.toContain('Alpha Customer');
  });

  test('read-only mode (trial ended) still exports both files', async () => {
    const owner = await who.as('owner');
    await mustCreate(owner, '/api/customers', { displayName: 'Before the trial ended' });
    await setStatus('trial_ended');

    for (const file of ['customers', 'jobs'] as const) {
      const res = await exportFile(owner, file);
      expect(res.status, file).toBe(200);
      expect(res.headers['content-type'], file).toMatch(/^text\/csv; charset=utf-8/);
    }
    expect((await exportFile(owner, 'customers')).text).toContain('Before the trial ended');
  });

  test('2,500 customers stream in id order', async () => {
    await inCompany(t, A(), (tx) =>
      tx.insert(customers).values(
        Array.from({ length: 2500 }, (_, i) => ({ companyId: A(), displayName: `Customer ${String(i + 1).padStart(4, '0')}` })),
      ),
    );

    const owner = await who.as('owner');
    const res = await exportFile(owner, 'customers');
    expect(res.status).toBe(200);

    const lines = linesOf(res.text);
    expect(lines).toHaveLength(2500 + 2);
    expect(lines[0]).toBe(CUSTOMER_EXPORT_HEADERS.join(','));
    expect(lines[lines.length - 1]).toBe('');

    const byId = await inCompany(t, A(), (tx) =>
      tx.select({ name: customers.displayName }).from(customers).orderBy(asc(customers.id)),
    );
    expect(byId).toHaveLength(2500);
    expect(lines.slice(1, -1).map((line) => line.split(',')[0])).toEqual(byId.map((row) => row.name));
  }, 60_000);

  test('every export writes an audit row', async () => {
    const owner = await who.as('owner');
    await maria(owner);

    expect((await exportFile(owner, 'customers')).status).toBe(200);
    expect(await dbAudit(t, A(), 'export.customers')).toHaveLength(1);
    expect(await dbAudit(t, A(), 'export.jobs')).toHaveLength(0);

    expect((await exportFile(owner, 'jobs')).status).toBe(200);
    expect(await dbAudit(t, A(), 'export.jobs')).toHaveLength(1);

    expect((await exportFile(owner, 'customers')).status).toBe(200);
    expect(await dbAudit(t, A(), 'export.customers')).toHaveLength(2);
  });
});
