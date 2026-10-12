import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppointmentKind } from '@roofline/shared';
import { agentTasks, appointments, customers } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/** The no-show appointment and the facts a reschedule text needs. */
export type NoShowTarget = {
  appointmentId: string;
  jobId: string | null;
  customerId: string;
  kind: AppointmentKind;
  startsAt: Date;
  assignedUserId: string | null;
  propertyId: string | null;
  customerFirstName: string;
  repFirstName: string | null;
};

const firstWord = (s: string | null | undefined): string => (s ?? '').trim().split(/\s+/)[0] ?? '';

/**
 * The appointment when it is still `no_show`, not archived, with a customer who is not archived, not
 * do-not-contact, and has a usable phone (same phone rule as `reminderCandidates`); otherwise null.
 */
export async function noShowTarget(tx: Tx, ctx: TenantContext, appointmentId: string): Promise<NoShowTarget | null> {
  const [r] = await tx
    .select({
      appointmentId: appointments.id,
      jobId: appointments.jobId,
      customerId: appointments.customerId,
      kind: appointments.kind,
      startsAt: appointments.startsAt,
      assignedUserId: appointments.assignedUserId,
      propertyId: appointments.propertyId,
      firstName: customers.firstName,
      displayName: customers.displayName,
      repName: sql<string | null>`(select m.name from company_members m where m.company_id = ${appointments.companyId} and m.user_id = ${appointments.assignedUserId} limit 1)`,
    })
    .from(appointments)
    .innerJoin(customers, and(eq(customers.companyId, appointments.companyId), eq(customers.id, appointments.customerId)))
    .where(
      and(
        eq(appointments.companyId, ctx.companyId),
        eq(appointments.id, appointmentId),
        eq(appointments.status, 'no_show'),
        isNull(appointments.archivedAt),
        sql`${appointments.customerId} is not null`,
        isNull(customers.archivedAt),
        eq(customers.doNotContact, false),
        sql`exists (select 1 from jsonb_array_elements(${customers.phones}) as p where btrim(coalesce(p->>'e164', '')) <> '')`,
      ),
    )
    .limit(1);
  if (!r || r.customerId === null) return null;
  return {
    appointmentId: r.appointmentId,
    jobId: r.jobId,
    customerId: r.customerId,
    kind: r.kind as AppointmentKind,
    startsAt: r.startsAt,
    assignedUserId: r.assignedUserId,
    propertyId: r.propertyId,
    customerFirstName: firstWord(r.firstName) || firstWord(r.displayName),
    repFirstName: firstWord(r.repName) || null,
  };
}

/** True when an agent task (agent 'scheduler', kind 'no_show', subject appointment/this id) exists, in any status. */
export async function noShowTaskExists(tx: Tx, ctx: TenantContext, appointmentId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.companyId, ctx.companyId),
        eq(agentTasks.agent, 'scheduler'),
        eq(agentTasks.kind, 'no_show'),
        eq(agentTasks.subjectType, 'appointment'),
        eq(agentTasks.subjectId, appointmentId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
