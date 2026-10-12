import { and, eq, sql } from 'drizzle-orm';
import { activities } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/** Whether an urgent Front Desk message was already recorded for this conversation (D1 Task 9). */
export async function hasUrgentNoticeFor(tx: Tx, ctx: TenantContext, conversationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(
        eq(activities.companyId, ctx.companyId),
        eq(activities.kind, 'front_desk_message'),
        sql`${activities.data}->>'conversationId' = ${conversationId}`,
        sql`${activities.data}->>'urgent' = 'true'`,
      ),
    )
    .limit(1);
  return row !== undefined;
}
