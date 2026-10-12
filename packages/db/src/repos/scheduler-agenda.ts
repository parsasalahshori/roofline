import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { auditLog, customers } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { primaryTextingPhone } from './agent-common.ts';
import { audit } from './audit.ts';

// G1 Task 10: crew agenda emails. Idempotency is the audit log: one `agenda.email_sent` row per member per local day.

export type AgendaMember = { userId: string; name: string; email: string };

const AGENDA_ACTION = 'agenda.email_sent';

/** Active members among `userIds` with their email, in the order of `userIds` (members with no row are left out). */
export async function agendaMembers(tx: Tx, ctx: TenantContext, userIds: string[]): Promise<AgendaMember[]> {
  if (userIds.length === 0) return [];
  // company_members is the view the tenant role reads (it has no grant on users); it is limited to the company.
  const result = await tx.execute(
    sql`select user_id, name, email from company_members where status = 'active' and user_id in (${sql.join(
      userIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
  const byId = new Map<string, AgendaMember>();
  for (const r of result.rows) {
    byId.set(r.user_id as string, { userId: r.user_id as string, name: r.name as string, email: String(r.email) });
  }
  void ctx;
  return userIds.flatMap((id) => {
    const m = byId.get(id);
    return m ? [m] : [];
  });
}

/** Primary (else first) customer phone in E.164, by customer id. Customers with no phone are absent. */
export async function customerPhones(tx: Tx, ctx: TenantContext, customerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (customerIds.length === 0) return out;
  const rows = await tx
    .select({ id: customers.id, phones: customers.phones })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, customerIds)));
  for (const r of rows) {
    const phones = Array.isArray(r.phones) ? r.phones : [];
    const pick = primaryTextingPhone(phones);
    if (pick !== null) out.set(r.id, pick);
  }
  return out;
}

/** True when an audit_log row `agenda.email_sent` for this member exists with `at` in [from, to). */
export async function agendaSentBetween(tx: Tx, ctx: TenantContext, userId: string, from: Date, to: Date): Promise<boolean> {
  const rows = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.companyId, ctx.companyId),
        eq(auditLog.action, AGENDA_ACTION),
        eq(auditLog.targetType, 'membership'),
        eq(auditLog.targetId, userId),
        gte(auditLog.at, from),
        lt(auditLog.at, to),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Writes the audit_log row `agenda.email_sent` (targetType 'membership', targetId userId, after { localDate }). */
export async function recordAgendaSent(tx: Tx, ctx: TenantContext, userId: string, localDate: string, at: Date): Promise<void> {
  await audit(tx, ctx, { action: AGENDA_ACTION, targetType: 'membership', targetId: userId, after: { localDate }, at });
}
