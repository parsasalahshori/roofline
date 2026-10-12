import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { appointments, customers, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { firstWord } from './agent-common.ts';

// G1 Task 10 (Builder 1 fills these in). Shell: signatures are final, bodies throw.

export type ReminderKind = 'inspection' | 'install' | 'adjuster';

/** One tomorrow appointment that can get a reminder text. */
export type ReminderCandidate = {
  appointmentId: string;
  jobId: string | null;
  customerId: string;
  kind: ReminderKind;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  customerFirstName: string;
  repFirstName: string | null;
  addressLine: string | null;
};

/**
 * Scheduled (not canceled, not archived) inspection/install/adjuster appointments starting in [from, to)
 * whose customer has a usable mobile phone (customers.phones non-empty with an e164), oldest first,
 * at most one per customer (their earliest).
 */
export async function reminderCandidates(tx: Tx, ctx: TenantContext, q: { from: Date; to: Date }): Promise<ReminderCandidate[]> {
  const rows = await tx
    .select({
      appointmentId: appointments.id,
      jobId: appointments.jobId,
      customerId: appointments.customerId,
      kind: appointments.kind,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      allDay: appointments.allDay,
      firstName: customers.firstName,
      displayName: customers.displayName,
      // company_members is the security-barrier view filtered to the current company (app.company_id).
      repName: sql<string | null>`(select m.name from company_members m where m.user_id = ${appointments.assignedUserId} limit 1)`,
      addressLine: properties.addressLine,
    })
    .from(appointments)
    .innerJoin(customers, and(eq(customers.companyId, appointments.companyId), eq(customers.id, appointments.customerId)))
    .leftJoin(properties, and(eq(properties.companyId, appointments.companyId), eq(properties.id, appointments.propertyId)))
    .where(
      and(
        eq(appointments.companyId, ctx.companyId),
        eq(appointments.status, 'scheduled'),
        isNull(appointments.archivedAt),
        inArray(appointments.kind, ['inspection', 'install', 'adjuster']),
        gte(appointments.startsAt, q.from),
        lt(appointments.startsAt, q.to),
        sql`${appointments.customerId} is not null`,
        isNull(customers.archivedAt),
        eq(customers.doNotContact, false),
        sql`exists (select 1 from jsonb_array_elements(${customers.phones}) as p where btrim(coalesce(p->>'e164', '')) <> '')`,
      ),
    )
    .orderBy(asc(appointments.startsAt), asc(appointments.id));
  const seen = new Set<string>();
  const out: ReminderCandidate[] = [];
  for (const r of rows) {
    if (r.customerId === null || seen.has(r.customerId)) continue;
    seen.add(r.customerId);
    out.push({
      appointmentId: r.appointmentId,
      jobId: r.jobId,
      customerId: r.customerId,
      kind: r.kind as ReminderKind,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      allDay: r.allDay,
      customerFirstName: firstWord(r.firstName) ?? firstWord(r.displayName) ?? '',
      repFirstName: firstWord(r.repName),
      addressLine: r.addressLine ?? null,
    });
  }
  return out;
}
