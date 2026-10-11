import { auditLog } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

export type AuditEntry = {
  /** What happened, dotted: `company.update`, `settings.update`, `member.update`, `invite.create`, `invite.accept`. */
  action: string;
  /** What kind of record it happened to (`company`, `company_settings`, `membership`, `invite`). */
  targetType: string;
  /** That record's id. */
  targetId: string;
  /** The values that changed, as they were. Only what the action touched; never secrets or tokens. */
  before?: Record<string, unknown>;
  /** The same values after the change. */
  after?: Record<string, unknown>;
  /** The caller's IP address, when the action came from a request. */
  ip?: string | null;
  /** When it happened. Pass the app clock's `now()`; the database's own clock is the fallback. */
  at?: Date;
};

/**
 * Appends one row to the company's audit log. Runs inside `withTenant`, so it is part of the
 * caller's transaction when there is one: the change and its audit row are saved together or not
 * at all. The actor is the context's user (null for the runner and the scheduler).
 * app_tenant can only insert and read this table: a row, once written, cannot be changed.
 */
export async function audit(tx: Tx, ctx: TenantContext, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    ...(entry.before !== undefined && { before: entry.before }),
    ...(entry.after !== undefined && { after: entry.after }),
    ip: entry.ip ?? null,
    ...(entry.at !== undefined && { at: entry.at }),
  });
}
