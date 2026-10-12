import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { getClaimPacketFacts, latestClaimPacket } from '../src/repos/claim-packet.ts';
import { getJobClaim, saveClaim, type ClaimPatch } from '../src/repos/claims.ts';
import { appointments, claimIntakes, customers, jobs, measurements, properties } from '../src/schema/index.ts';
import { type TenantContext, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });
const owner = new pg.Client({ connectionString: urls.owner });

let seed: { a: SeededCompany; b: SeededCompany };

beforeAll(async () => {
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  await owner.query('truncate storms, spotter_reports cascade');
  seed = await seedTwoCompanies(urls.owner);
});

const NOW = new Date('2026-10-12T15:00:00.000Z');
const DOL = '2026-09-30';
const DAY_BEFORE = '2026-09-29';
const TWO_BEFORE = '2026-09-28';
/** The property point. */
const LNG = -96;
const LAT = 41;

function ownerCtx(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: c.owner.userId, role: 'owner', canApproveSpend: true };
}

function repCtx(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: c.rep.userId, role: 'rep', canApproveSpend: false };
}

let addressCounter = 0;

/** A customer, an address (at the property point) and a job in the company. */
async function makeJob(
  c: SeededCompany,
  assignedUserId: string | null = null,
): Promise<{ jobId: string; propertyId: string }> {
  addressCounter += 1;
  const n = addressCounter;
  const ctx = ownerCtx(c);
  return withTenant(pools, ctx, async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({ companyId: c.companyId, displayName: `Customer ${n}` })
      .returning({ id: customers.id });
    const [property] = await tx
      .insert(properties)
      .values({
        companyId: c.companyId,
        customerId: customer!.id,
        addressLine: `${100 + n} Oak St`,
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: `${100 + n} oak st|68102`,
        geom: [LNG, LAT],
      })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({
        companyId: c.companyId,
        customerId: customer!.id,
        propertyId: property!.id,
        stage: 'inspection',
        assignedUserId,
        createdByUserId: c.owner.userId,
      })
      .returning({ id: jobs.id });
    return { jobId: job!.id, propertyId: property!.id };
  });
}

async function makeClaim(c: SeededCompany, jobId: string, patch: ClaimPatch = { dateOfLoss: DOL }): Promise<string> {
  const ctx = ownerCtx(c);
  const view = await withTenant(pools, ctx, (tx) =>
    saveClaim(tx, ctx, jobId, patch, { actor: 'user', userId: c.owner.userId }, NOW),
  );
  return view!.id;
}

function facts(c: SeededCompany, jobId: string, ctx: TenantContext = ownerCtx(c)) {
  return withTenant(pools, ctx, (tx) => getClaimPacketFacts(tx, ctx, jobId));
}

/** A square of `half` degrees around the property point, as a MULTIPOLYGON. */
function square(half: number, lng = LNG, lat = LAT): string {
  const [w, e, s, n] = [lng - half, lng + half, lat - half, lat + half];
  return `MULTIPOLYGON((( ${w} ${s}, ${w} ${n}, ${e} ${n}, ${e} ${s}, ${w} ${s} )))`;
}

async function insertStorm(day: string, contours: { thresholdIn: number; wkt: string }[]): Promise<string> {
  const res = await owner.query<{ id: string }>(
    `insert into storms (convective_day, max_in, geom_075, bbox, centroid)
     values ($1::date, 1.50, ST_GeomFromText($2, 4326), ST_GeomFromText('POLYGON((-97 40,-97 42,-95 42,-95 40,-97 40))', 4326),
             ST_GeomFromText('POINT(-96 41)', 4326)) returning id`,
    [day, square(1)],
  );
  const id = res.rows[0]!.id;
  for (const c of contours) {
    await owner.query(
      `insert into storm_contours (storm_id, threshold_in, geom) values ($1, $2, ST_GeomFromText($3, 4326))`,
      [id, c.thresholdIn, c.wkt],
    );
  }
  return id;
}

async function insertSpotter(day: string, time: string, sizeIn: number, lat: number, lng = LNG): Promise<void> {
  await owner.query(
    `insert into spotter_reports (report_date, time_utc, size_in, location, county, state, geom)
     values ($1::date, $2::time, $3, 'Near town', 'Douglas', 'NE', ST_SetSRID(ST_MakePoint($4, $5), 4326))`,
    [day, time, sizeIn, lng, lat],
  );
}

describe('hail', () => {
  test('hail: the largest contour containing the property on the date of loss', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c);
    await makeClaim(c, jobId);
    await insertStorm(DOL, [
      { thresholdIn: 0.75, wkt: square(0.5) },
      { thresholdIn: 1.5, wkt: square(0.1) },
    ]);
    expect((await facts(c, jobId))?.hail).toEqual({ thresholdIn: 1.5, convectiveDay: DOL });

    // A storm of the day before counts, and wins when its contour is larger.
    await insertStorm(DAY_BEFORE, [{ thresholdIn: 2, wkt: square(0.1) }]);
    expect((await facts(c, jobId))?.hail).toEqual({ thresholdIn: 2, convectiveDay: DAY_BEFORE });

    // A storm two days earlier does not.
    await insertStorm(TWO_BEFORE, [{ thresholdIn: 3, wkt: square(0.1) }]);
    expect((await facts(c, jobId))?.hail).toEqual({ thresholdIn: 2, convectiveDay: DAY_BEFORE });
  });

  test('hail: null when no contour contains the point', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c);
    await makeClaim(c, jobId);
    await insertStorm(DOL, [{ thresholdIn: 1.5, wkt: square(0.1, -90, 35) }]);
    expect((await facts(c, jobId))?.hail).toBeNull();
  });

  test('hail: null when the claim has no date of loss', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c);
    await makeClaim(c, jobId, { insurer: 'Acme Mutual' });
    await insertStorm(DOL, [{ thresholdIn: 1.5, wkt: square(0.1) }]);
    await insertSpotter(DOL, '18:00:00', 1.5, LAT);
    const f = await facts(c, jobId);
    expect(f?.dateOfLoss).toBeNull();
    expect(f?.hail).toBeNull();
    expect(f?.spotterReports).toEqual([]);
  });
});

describe('spotter reports', () => {
  test('spotter reports: only within 10 miles and on the day, largest first then earliest, at most 10', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c);
    await makeClaim(c, jobId);
    await insertSpotter(DOL, '17:00:00', 1.0, LAT + 0.072); // about 5 miles
    await insertSpotter(DOL, '17:00:00', 4.0, LAT + 0.174); // about 12 miles, excluded
    await insertSpotter('2026-09-27', '17:00:00', 4.0, LAT + 0.01); // wrong day, excluded
    await insertSpotter('2026-10-01', '17:00:00', 4.0, LAT + 0.01); // wrong day, excluded
    const f1 = await facts(c, jobId);
    expect(f1?.spotterReports).toEqual([
      { sizeIn: 1, reportDate: DOL, timeUtc: '17:00:00', location: 'Near town', county: 'Douglas', state: 'NE' },
    ]);

    // Ten more inside: only 10 come back, largest first, then earliest.
    for (let i = 0; i < 9; i += 1) {
      await insertSpotter(DOL, `18:0${i}:00`, 1.25, LAT + 0.01 * (i + 1) / 10);
    }
    await insertSpotter(DOL, '16:00:00', 1.25, LAT + 0.02);
    await insertSpotter(DAY_BEFORE, '23:00:00', 2.0, LAT + 0.03);
    const f2 = await facts(c, jobId);
    expect(f2?.spotterReports).toHaveLength(10);
    expect(f2?.spotterReports[0]).toMatchObject({ sizeIn: 2, reportDate: DAY_BEFORE, timeUtc: '23:00:00' });
    expect(f2?.spotterReports[1]).toMatchObject({ sizeIn: 1.25, timeUtc: '16:00:00' });
    expect(f2?.spotterReports[2]).toMatchObject({ sizeIn: 1.25, timeUtc: '18:00:00' });
    expect(f2?.spotterReports.every((r) => r.sizeIn >= 1.25)).toBe(true);
    expect(f2?.spotterReports.some((r) => r.sizeIn === 1)).toBe(false);
  });
});

describe('measurement, inspection and notes', () => {
  test('measurement: latest for the property with its label', async () => {
    const c = seed.a;
    const { jobId, propertyId } = await makeJob(c);
    await makeClaim(c, jobId);
    expect((await facts(c, jobId))?.measurement).toBeNull();

    const insert = (kind: 'estimate' | 'exact', surfaceSqFt: number, pitchX12: number, createdAt: Date) =>
      withTenant(pools, ownerCtx(c), (tx) =>
        tx.insert(measurements).values({
          companyId: c.companyId,
          propertyId,
          kind,
          method: kind === 'exact' ? 'eagleview' : 'aerial',
          surfaceSqFt,
          pitchX12,
          createdAt,
        }),
      );
    await insert('estimate', 2345, 6, new Date('2026-10-01T10:00:00.000Z'));
    expect((await facts(c, jobId))?.measurement).toEqual({
      kind: 'estimate',
      label: 'Estimate (aerial/footprint)',
      roofAreaSqFt: 2345,
      roofSquares: 23.5,
      pitchX12: 6,
      measuredAt: '2026-10-01T10:00:00.000Z',
    });

    await insert('exact', 2400, 7, new Date('2026-10-05T10:00:00.000Z'));
    expect((await facts(c, jobId))?.measurement).toMatchObject({
      kind: 'exact',
      label: 'Exact report',
      roofAreaSqFt: 2400,
      roofSquares: 24,
      pitchX12: 7,
    });
  });

  test('inspection and intake notes', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c);
    await makeClaim(c, jobId);
    const add = (status: 'scheduled' | 'completed', startsAt: string, notes: string) =>
      withTenant(pools, ownerCtx(c), (tx) =>
        tx.insert(appointments).values({
          companyId: c.companyId,
          kind: 'inspection',
          jobId,
          status,
          notes,
          startsAt: new Date(startsAt),
          endsAt: new Date(new Date(startsAt).getTime() + 3_600_000),
        }),
      );
    await add('scheduled', '2026-10-20T15:00:00.000Z', 'Not yet');
    const before = await facts(c, jobId);
    expect(before?.inspection).toBeNull();
    expect(before?.intakeNotes).toBeNull();

    await add('completed', '2026-10-02T15:00:00.000Z', 'Hail hits on the north slope');
    await withTenant(pools, ownerCtx(c), (tx) =>
      tx.insert(claimIntakes).values({
        companyId: c.companyId,
        jobId,
        insurer: 'Acme Mutual',
        description: 'Hail on the north slope',
        takenBy: 'front_desk',
      }),
    );
    const after = await facts(c, jobId);
    expect(after?.inspection).toEqual({ date: '2026-10-02T15:00:00.000Z', notes: 'Hail hits on the north slope' });
    expect(after?.intakeNotes).toBe('Hail on the north slope');
  });

  test('the basics: company, customer, address, point and claim fields', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c);
    const claimId = await makeClaim(c, jobId, { dateOfLoss: DOL, insurer: 'Acme Mutual', claimNumber: 'C-9' });
    const f = await facts(c, jobId);
    expect(f).toMatchObject({
      claimId,
      jobId,
      customerName: expect.stringMatching(/^Customer /),
      address: expect.stringMatching(/^1\d\d Oak St, Omaha, NE 68102$/),
      propertyCenter: [LNG, LAT],
      insurer: 'Acme Mutual',
      claimNumber: 'C-9',
      dateOfLoss: DOL,
    });
    expect(typeof f?.company.name).toBe('string');
    expect(typeof f?.timeZone).toBe('string');
  });
});

describe('visibility', () => {
  test('a rep outside the job gets null', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c, null);
    await makeClaim(c, jobId);
    expect(await facts(c, jobId, repCtx(c))).toBeNull();
    expect(await facts(c, jobId)).not.toBeNull();
    const mine = await makeJob(c, c.rep.userId);
    await makeClaim(c, mine.jobId);
    expect(await facts(c, mine.jobId, repCtx(c))).not.toBeNull();
  });

  test('no claim -> null', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c);
    expect(await facts(c, jobId)).toBeNull();
    expect(await facts(seed.b, jobId)).toBeNull();
  });
});

describe('claim packet file', () => {
  async function insertFile(companyId: string, kind: string, key: string, createdAt: string): Promise<string> {
    const res = await owner.query<{ id: string }>(
      `insert into stored_files (company_id, kind, object_key, sha256, bytes, content_type, created_at)
       values ($1, $2, $3, repeat('a', 64), 10, 'application/pdf', $4) returning id`,
      [companyId, kind, key, createdAt],
    );
    return res.rows[0]!.id;
  }

  test('latestClaimPacket: newest kind claim_packet file under the claim prefix', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c);
    const claimId = await makeClaim(c, jobId);
    const ctx = ownerCtx(c);
    const latest = () => withTenant(pools, ctx, (tx) => latestClaimPacket(tx, ctx, claimId));
    expect(await latest()).toBeNull();

    await insertFile(c.companyId, 'claim_packet', `claim-packets/${claimId}/1.pdf`, '2026-10-01T10:00:00.000Z');
    const newest = await insertFile(c.companyId, 'claim_packet', `claim-packets/${claimId}/2.pdf`, '2026-10-02T10:00:00.000Z');
    await insertFile(c.companyId, 'claim_packet', 'claim-packets/00000000-0000-4000-8000-000000000000/3.pdf', '2026-10-03T10:00:00.000Z');
    await insertFile(c.companyId, 'ad_image', `claim-packets/${claimId}/4.pdf`, '2026-10-04T10:00:00.000Z');
    expect(await latest()).toEqual({
      storedFileId: newest,
      objectKey: `claim-packets/${claimId}/2.pdf`,
      contentType: 'application/pdf',
      builtAt: new Date('2026-10-02T10:00:00.000Z'),
    });
    // Another company never sees it.
    const other = ownerCtx(seed.b);
    expect(await withTenant(pools, other, (tx) => latestClaimPacket(tx, other, claimId))).toBeNull();
  });

  test('getJobClaim returns packet {storedFileId, builtAt}', async () => {
    const c = seed.a;
    const { jobId } = await makeJob(c);
    const ctx = ownerCtx(c);
    expect((await withTenant(pools, ctx, (tx) => getJobClaim(tx, ctx, jobId)))?.packet).toBeNull();
    const claimId = await makeClaim(c, jobId);
    expect((await withTenant(pools, ctx, (tx) => getJobClaim(tx, ctx, jobId)))?.packet).toBeNull();
    const id = await insertFile(c.companyId, 'claim_packet', `claim-packets/${claimId}/1.pdf`, '2026-10-02T10:00:00.000Z');
    expect((await withTenant(pools, ctx, (tx) => getJobClaim(tx, ctx, jobId)))?.packet).toEqual({
      storedFileId: id,
      builtAt: '2026-10-02T10:00:00.000Z',
    });
  });
});
