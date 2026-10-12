import { and, desc, eq, like, sql } from 'drizzle-orm';
import type { ClaimPacketFacts } from '@roofline/shared';
import {
  appointments,
  claimIntakes,
  claims,
  companies,
  customers,
  jobs,
  measurements,
  properties,
  storedFiles,
} from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { jobScope } from './scope.ts';

// G1 Task 7: the facts the claim packet PDF prints.

/** Spotter reports count within 10 miles of the property. */
const SPOTTER_RADIUS_M = 16093;
const SPOTTER_LIMIT = 10;
const ESTIMATE_LABEL = 'Estimate (aerial/footprint)';
const EXACT_LABEL = 'Exact report';

/** The calendar day before a YYYY-MM-DD date (UTC date arithmetic). */
function dayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function loadHail(
  tx: Tx,
  point: [number, number],
  days: [string, string],
): Promise<ClaimPacketFacts['hail']> {
  const pt = sql`ST_SetSRID(ST_MakePoint(${point[0]}::float8, ${point[1]}::float8), 4326)`;
  const result = await tx.execute(sql`
    select c.threshold_in::float8 as threshold_in, s.convective_day::text as convective_day
      from storm_contours c
      join storms s on s.id = c.storm_id
     where s.convective_day in (${days[0]}::date, ${days[1]}::date)
       and ST_Intersects(c.geom, ${pt})
     order by c.threshold_in desc, s.convective_day desc
     limit 1`);
  const row = result.rows[0];
  if (!row) return null;
  return { thresholdIn: Number(row.threshold_in), convectiveDay: String(row.convective_day) };
}

async function loadSpotterReports(
  tx: Tx,
  point: [number, number],
  days: [string, string],
): Promise<ClaimPacketFacts['spotterReports']> {
  const pt = sql`ST_SetSRID(ST_MakePoint(${point[0]}::float8, ${point[1]}::float8), 4326)`;
  const result = await tx.execute(sql`
    select size_in::float8 as size_in, report_date::text as report_date, time_utc::text as time_utc,
           location, county, state::text as state
      from spotter_reports
     where report_date in (${days[0]}::date, ${days[1]}::date)
       and ST_DWithin(geom::geography, ${pt}::geography, ${SPOTTER_RADIUS_M}::float8)
     order by size_in desc, report_date asc, time_utc asc
     limit ${SPOTTER_LIMIT}`);
  return result.rows.map((row) => ({
    sizeIn: Number(row.size_in),
    reportDate: String(row.report_date),
    timeUtc: String(row.time_utc).slice(0, 8),
    location: row.location === null ? null : String(row.location),
    county: row.county === null ? null : String(row.county),
    state: String(row.state),
  }));
}

/** Everything the claim packet prints for the job's claim, read at the moment of the call. Null when the job is not visible to the member or has no claim. */
export async function getClaimPacketFacts(tx: Tx, ctx: TenantContext, jobId: string): Promise<ClaimPacketFacts | null> {
  const [job] = await tx
    .select({
      propertyId: jobs.propertyId,
      customerName: customers.displayName,
      addressLine: properties.addressLine,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      geom: properties.geom,
    })
    .from(jobs)
    .innerJoin(customers, and(eq(customers.id, jobs.customerId), eq(customers.companyId, jobs.companyId)))
    .innerJoin(properties, and(eq(properties.id, jobs.propertyId), eq(properties.companyId, jobs.companyId)))
    .where(and(eq(jobs.id, jobId), eq(jobs.companyId, ctx.companyId), jobScope(ctx)))
    .limit(1);
  if (!job) return null;

  const [claim] = await tx
    .select()
    .from(claims)
    .where(and(eq(claims.jobId, jobId), eq(claims.companyId, ctx.companyId)))
    .limit(1);
  if (!claim) return null;

  const [company] = await tx
    .select({ name: companies.name, phone: companies.phoneE164, timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);

  const propertyCenter: [number, number] | null = job.geom ? [job.geom[0], job.geom[1]] : null;

  let hail: ClaimPacketFacts['hail'] = null;
  let spotterReports: ClaimPacketFacts['spotterReports'] = [];
  if (claim.dateOfLoss !== null && propertyCenter) {
    const days: [string, string] = [claim.dateOfLoss, dayBefore(claim.dateOfLoss)];
    hail = await loadHail(tx, propertyCenter, days);
    spotterReports = await loadSpotterReports(tx, propertyCenter, days);
  }

  const [m] = await tx
    .select()
    .from(measurements)
    .where(and(eq(measurements.propertyId, job.propertyId), eq(measurements.companyId, ctx.companyId)))
    .orderBy(desc(measurements.createdAt), desc(measurements.id))
    .limit(1);
  const measurement: ClaimPacketFacts['measurement'] = m
    ? {
        kind: m.kind,
        label: m.kind === 'exact' ? EXACT_LABEL : ESTIMATE_LABEL,
        roofAreaSqFt: m.surfaceSqFt,
        roofSquares: m.surfaceSqFt === null ? null : Math.round(m.surfaceSqFt / 10) / 10,
        pitchX12: m.pitchX12,
        measuredAt: m.createdAt.toISOString(),
      }
    : null;

  const [visit] = await tx
    .select({ startsAt: appointments.startsAt, notes: appointments.notes })
    .from(appointments)
    .where(
      and(
        eq(appointments.jobId, jobId),
        eq(appointments.companyId, ctx.companyId),
        eq(appointments.kind, 'inspection'),
        eq(appointments.status, 'completed'),
      ),
    )
    .orderBy(desc(appointments.startsAt), desc(appointments.id))
    .limit(1);

  const [intake] = await tx
    .select({ description: claimIntakes.description })
    .from(claimIntakes)
    .where(and(eq(claimIntakes.jobId, jobId), eq(claimIntakes.companyId, ctx.companyId)))
    .orderBy(desc(claimIntakes.createdAt), desc(claimIntakes.id))
    .limit(1);

  return {
    claimId: claim.id,
    jobId,
    company: { name: company?.name ?? '', phone: company?.phone ?? null },
    timeZone: company?.timezone ?? 'America/Chicago',
    customerName: job.customerName,
    address: `${job.addressLine}, ${job.city}, ${job.state} ${job.zip}`,
    propertyCenter,
    insurer: claim.insurer,
    claimNumber: claim.claimNumber,
    dateOfLoss: claim.dateOfLoss,
    hail,
    spotterReports,
    measurement,
    inspection: visit ? { date: visit.startsAt.toISOString(), notes: visit.notes } : null,
    intakeNotes: intake?.description ?? null,
  };
}

/** The newest stored file of kind 'claim_packet' whose object_key starts with `claim-packets/{claimId}/`. Null when none. */
export async function latestClaimPacket(
  tx: Tx,
  ctx: TenantContext,
  claimId: string,
): Promise<{ storedFileId: string; objectKey: string; contentType: string; builtAt: Date } | null> {
  const [row] = await tx
    .select({
      id: storedFiles.id,
      objectKey: storedFiles.objectKey,
      contentType: storedFiles.contentType,
      createdAt: storedFiles.createdAt,
    })
    .from(storedFiles)
    .where(
      and(
        eq(storedFiles.companyId, ctx.companyId),
        eq(storedFiles.kind, 'claim_packet'),
        like(storedFiles.objectKey, `claim-packets/${claimId}/%`),
      ),
    )
    .orderBy(desc(storedFiles.createdAt), desc(storedFiles.id))
    .limit(1);
  if (!row) return null;
  return { storedFileId: row.id, objectKey: row.objectKey, contentType: row.contentType, builtAt: row.createdAt };
}
