import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Agent, ClaimStatus } from '@roofline/shared';
import { agentTasks, appointments, claims, companies, companySettings, customers, jobs, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * What the Claims agent's daily run reads (G1 Task 8): the claims that might need a check-in text,
 * the company's nudge days, and whether the agent already made its plan today. The caller applies
 * `claimNudgeDue` and the follow-up limits; nothing here decides whether a nudge is due. Everything
 * runs inside `withTenant`, and each query also names the company.
 */

export type ClaimCandidate = {
  claimId: string;
  jobId: string;
  customerId: string;
  customerFirstName: string;
  mobileE164: string;
  status: ClaimStatus;
  statusChangedAt: Date;
  /** The end of the job's latest completed inspection, or null. */
  inspectedAt: Date | null;
  /** The start of the claim's adjuster appointment, or null. */
  adjusterAt: Date | null;
  repFirstName: string | null;
  address: string | null;
};

/** Claims in these statuses can have a nudge due; every other status cannot. */
const NUDGE_STATUSES: ClaimStatus[] = ['not_filed', 'filed', 'adjuster_scheduled'];

const DEFAULT_NUDGE_DAYS = [3, 5, 7];

/** The customer's primary number, else their first, else null (the same choice the texting gate makes). */
function mobileOf(phones: readonly { e164?: unknown; primary?: boolean }[]): string | null {
  const usable = phones.filter((p) => typeof p?.e164 === 'string' && p.e164.trim() !== '');
  const chosen = usable.find((p) => p.primary === true) ?? usable[0];
  return typeof chosen?.e164 === 'string' ? chosen.e164 : null;
}

function firstWord(name: string | null | undefined): string | null {
  const word = name?.trim().split(/\s+/)[0];
  return word ? word : null;
}

/**
 * The company's claims in a status that can be nudged, whose customer has a phone number and can
 * still be contacted, oldest claim first. The caller decides which are due.
 */
export async function listClaimNudgeCandidates(tx: Tx, ctx: TenantContext, now: Date): Promise<ClaimCandidate[]> {
  void now;
  const inspectedAt = sql<Date | null>`(
    select max(${appointments.endsAt}) from ${appointments}
    where ${appointments.companyId} = ${ctx.companyId}
      and ${appointments.jobId} = ${jobs.id}
      and ${appointments.kind} = 'inspection'
      and ${appointments.status} = 'completed'
      and ${appointments.archivedAt} is null
  )`.mapWith(appointments.endsAt);
  const rows = await tx
    .select({
      claimId: claims.id,
      jobId: claims.jobId,
      customerId: customers.id,
      firstName: customers.firstName,
      displayName: customers.displayName,
      phones: customers.phones,
      status: claims.status,
      statusChangedAt: claims.statusChangedAt,
      createdAt: claims.createdAt,
      inspectedAt,
      adjusterAt: appointments.startsAt,
      repName: sql<string | null>`(select m.name from company_members m where m.user_id = ${jobs.assignedUserId} limit 1)`,
      addressLine: properties.addressLine,
    })
    .from(claims)
    .innerJoin(jobs, and(eq(jobs.id, claims.jobId), eq(jobs.companyId, ctx.companyId)))
    .innerJoin(customers, and(eq(customers.id, jobs.customerId), eq(customers.companyId, ctx.companyId)))
    .leftJoin(properties, and(eq(properties.id, jobs.propertyId), eq(properties.companyId, ctx.companyId)))
    .leftJoin(appointments, and(eq(appointments.id, claims.adjusterAppointmentId), eq(appointments.companyId, ctx.companyId)))
    .where(
      and(
        eq(claims.companyId, ctx.companyId),
        inArray(claims.status, NUDGE_STATUSES),
        isNull(jobs.archivedAt),
        isNull(customers.archivedAt),
        eq(customers.doNotContact, false),
        sql`jsonb_array_length(${customers.phones}) > 0`,
      ),
    )
    .orderBy(asc(claims.createdAt), asc(claims.id));

  const out: ClaimCandidate[] = [];
  for (const row of rows) {
    const mobileE164 = mobileOf(row.phones);
    if (mobileE164 === null) continue;
    out.push({
      claimId: row.claimId,
      jobId: row.jobId,
      customerId: row.customerId,
      customerFirstName: firstWord(row.firstName) ?? firstWord(row.displayName) ?? 'there',
      mobileE164,
      status: row.status,
      statusChangedAt: row.statusChangedAt,
      inspectedAt: row.inspectedAt ?? null,
      adjusterAt: row.adjusterAt,
      repFirstName: firstWord(row.repName),
      address: row.addressLine,
    });
  }
  return out;
}

/** The company's claims_nudge_days (days after inspection, after filing, after the adjuster visit); [3, 5, 7] without a row. */
export async function claimNudgeDays(tx: Tx, ctx: TenantContext): Promise<number[]> {
  const [row] = await tx
    .select({ days: companySettings.claimsNudgeDays })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  const days = row?.days;
  return days && days.length >= 3 ? [...days] : [...DEFAULT_NUDGE_DAYS];
}

/** The company's status, name and time zone, or null when the company cannot be seen. */
export async function companyRunFacts(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ status: string; name: string; timezone: string } | null> {
  const [row] = await tx
    .select({ status: companies.status, name: companies.name, timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row ?? null;
}

/** Whether the agent already made a task of this kind with a creation time in [dayStart, dayEnd). */
export async function hasAgentTaskToday(
  tx: Tx,
  ctx: TenantContext,
  agent: Agent,
  kind: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.companyId, ctx.companyId),
        eq(agentTasks.agent, agent),
        eq(agentTasks.kind, kind),
        gte(agentTasks.createdAt, dayStart),
        lt(agentTasks.createdAt, dayEnd),
      ),
    )
    .limit(1);
  return row !== undefined;
}
