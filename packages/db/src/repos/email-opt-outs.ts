import { and, eq } from 'drizzle-orm';
import { emailOptOuts } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/** Whether the address is on the company's email_opt_outs (case-insensitive: the column is citext). */
export async function isEmailOptedOut(tx: Tx, ctx: TenantContext, email: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: emailOptOuts.id })
    .from(emailOptOuts)
    .where(and(eq(emailOptOuts.companyId, ctx.companyId), eq(emailOptOuts.email, email.trim())))
    .limit(1);
  return row !== undefined;
}
