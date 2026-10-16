import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { hailHitsForProperties, proposalStatusForJob } from '../src/repos/fd-caller.ts';
import { createPools, type Pools } from '../src/pools.ts';
import { type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { insertFixtureProperty, insertOmahaStorm, OMAHA_CORE, type Query } from './fixtures/storms.ts';

const urls = inject('dbUrls');

let owner: pg.Pool;
let pools: Pools;
let seed: { a: SeededCompany; b: SeededCompany };

const q: Query = async (text, values) => (await owner.query(text, values)).rows;
const ctxOf = (companyId: string) => ({ companyId, userId: null, role: 'system' as const, canApproveSpend: false });
const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) => withTenant(pools, ctxOf(companyId), fn);

const NOW = new Date('2026-10-16T15:00:00Z');

/** A storm on `day`, the company's view of it, and one hit on `propertyId` with `hailIn`. */
async function insertHit(companyId: string, propertyId: string, day: string, hailIn: number, opts: { mergedInto?: string } = {}) {
  const stormId = await insertOmahaStorm(q, day);
  if (opts.mergedInto) await q(`update storms set merged_into = $2 where id = $1`, [stormId, opts.mergedInto]);
  const [cs] = await q(`insert into company_storms (company_id, storm_id, max_in) values ($1, $2, $3) returning id`, [companyId, stormId, hailIn]);
  await q(`insert into storm_hits (company_id, company_storm_id, property_id, hail_in) values ($1, $2, $3, $4)`, [
    companyId,
    cs!.id,
    propertyId,
    hailIn,
  ]);
  return stormId;
}

let proposalSeq = 0;

/** A job (with customer, property and measurement) for the company; returns the ids a proposal needs. */
async function insertJob(companyId: string) {
  const { propertyId, customerId } = await insertFixtureProperty(q, companyId, OMAHA_CORE);
  const [job] = await q(`insert into jobs (company_id, customer_id, property_id) values ($1, $2, $3) returning id`, [companyId, customerId, propertyId]);
  const [m] = await q(`insert into measurements (company_id, property_id, kind, method) values ($1, $2, 'estimate', 'manual') returning id`, [
    companyId,
    propertyId,
  ]);
  return { companyId, customerId: customerId!, propertyId, jobId: job!.id as string, measurementId: m!.id as string };
}

async function insertProposal(
  job: Awaited<ReturnType<typeof insertJob>>,
  status: string,
  opts: { validUntil?: string; sentAt?: string } = {},
): Promise<string> {
  proposalSeq += 1;
  const [row] = await q(
    `insert into proposals (company_id, customer_id, property_id, job_id, measurement_id, number,
        status, valid_until, estimate_basis, link_token_hash, link_token_encrypted, sent_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'estimate', $9, $10, $11) returning id`,
    [
      job.companyId,
      job.customerId,
      job.propertyId,
      job.jobId,
      job.measurementId,
      `P-${String(proposalSeq).padStart(4, '0')}`,
      status,
      opts.validUntil ?? '2026-12-31',
      Buffer.from(`hash-${proposalSeq}-${job.jobId}`),
      Buffer.from('encrypted-placeholder'),
      status === 'draft' ? null : (opts.sentAt ?? '2026-10-01T12:00:00Z'),
    ],
  );
  return row!.id as string;
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: urls.owner });
  pools = createPools({ tenant: urls.tenant, system: urls.system });
});

afterAll(async () => {
  await pools?.end();
  await owner?.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('hailHitsForProperties', () => {
  test('returns recent hits newest first with the radar hail size and the storm day', async () => {
    const { propertyId } = await insertFixtureProperty(q, seed.a.companyId, OMAHA_CORE);
    await insertHit(seed.a.companyId, propertyId, '2026-10-03', 1.5);
    await insertHit(seed.a.companyId, propertyId, '2026-10-10', 1.0);
    const hits = await asCompany(seed.a.companyId, (tx) => hailHitsForProperties(tx, ctxOf(seed.a.companyId), [propertyId], 30, NOW));
    expect(hits).toEqual([
      { propertyId, occurredOn: '2026-10-10', hailSizeInches: 1 },
      { propertyId, occurredOn: '2026-10-03', hailSizeInches: 1.5 },
    ]);
  });

  test('skips storms older than the window and storms merged into another', async () => {
    const { propertyId } = await insertFixtureProperty(q, seed.a.companyId, OMAHA_CORE);
    await insertHit(seed.a.companyId, propertyId, '2026-09-01', 2.0);
    const kept = await insertHit(seed.a.companyId, propertyId, '2026-10-12', 1.25);
    await insertHit(seed.a.companyId, propertyId, '2026-10-13', 1.75, { mergedInto: kept });
    const hits = await asCompany(seed.a.companyId, (tx) => hailHitsForProperties(tx, ctxOf(seed.a.companyId), [propertyId], 30, NOW));
    expect(hits).toEqual([{ propertyId, occurredOn: '2026-10-12', hailSizeInches: 1.25 }]);
  });

  test("never returns another company's hits, and no property ids means no hits", async () => {
    const b = await insertFixtureProperty(q, seed.b.companyId, OMAHA_CORE);
    await insertHit(seed.b.companyId, b.propertyId, '2026-10-10', 1.5);
    await asCompany(seed.a.companyId, async (tx) => {
      expect(await hailHitsForProperties(tx, ctxOf(seed.a.companyId), [b.propertyId], 30, NOW)).toEqual([]);
      expect(await hailHitsForProperties(tx, ctxOf(seed.a.companyId), [], 30, NOW)).toEqual([]);
    });
    const own = await asCompany(seed.b.companyId, (tx) => hailHitsForProperties(tx, ctxOf(seed.b.companyId), [b.propertyId], 30, NOW));
    expect(own).toHaveLength(1);
  });
});

describe('proposalStatusForJob', () => {
  const statusOf = (companyId: string, jobId: string) =>
    asCompany(companyId, (tx) => proposalStatusForJob(tx, ctxOf(companyId), jobId, NOW));

  test('null with no proposal or only a draft', async () => {
    const job = await insertJob(seed.a.companyId);
    expect(await statusOf(seed.a.companyId, job.jobId)).toBeNull();
    await insertProposal(job, 'draft');
    expect(await statusOf(seed.a.companyId, job.jobId)).toBeNull();
  });

  test('sent, then viewed, follow the open proposal', async () => {
    const job = await insertJob(seed.a.companyId);
    const id = await insertProposal(job, 'sent');
    expect(await statusOf(seed.a.companyId, job.jobId)).toBe('sent');
    await q(`update proposals set status = 'viewed' where id = $1`, [id]);
    expect(await statusOf(seed.a.companyId, job.jobId)).toBe('viewed');
  });

  test('signed wins over a newer open revision', async () => {
    const job = await insertJob(seed.a.companyId);
    await insertProposal(job, 'signed', { sentAt: '2026-09-20T12:00:00Z' });
    await insertProposal(job, 'sent', { sentAt: '2026-10-05T12:00:00Z' });
    expect(await statusOf(seed.a.companyId, job.jobId)).toBe('signed');
  });

  test('a replaced proposal is ignored for its open revision; declined and past-due proposals are null', async () => {
    const job = await insertJob(seed.a.companyId);
    await insertProposal(job, 'replaced', { sentAt: '2026-09-20T12:00:00Z' });
    await insertProposal(job, 'viewed', { sentAt: '2026-10-05T12:00:00Z' });
    expect(await statusOf(seed.a.companyId, job.jobId)).toBe('viewed');

    const declined = await insertJob(seed.a.companyId);
    await insertProposal(declined, 'declined');
    expect(await statusOf(seed.a.companyId, declined.jobId)).toBeNull();

    const late = await insertJob(seed.a.companyId);
    await insertProposal(late, 'sent', { validUntil: '2026-10-15' });
    expect(await statusOf(seed.a.companyId, late.jobId)).toBeNull();
  });

  test("another company's job reads as null", async () => {
    const job = await insertJob(seed.b.companyId);
    await insertProposal(job, 'signed');
    expect(await statusOf(seed.a.companyId, job.jobId)).toBeNull();
    expect(await statusOf(seed.b.companyId, job.jobId)).toBe('signed');
  });
});
