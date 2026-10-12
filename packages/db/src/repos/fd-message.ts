import { and, eq, sql } from 'drizzle-orm';
import { activities, conversations, conversationTurns } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/** Whether an urgent Front Desk message was already recorded for this conversation (D1 Task 9). */
export async function hasUrgentNoticeFor(tx: Tx, ctx: TenantContext, conversationId: string): Promise<boolean> {
  // Serializes concurrent take_message calls of one conversation (two texts, or a second relay session):
  // the second waits here until the first commits, then sees its notice below.
  await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, conversationId)))
    .for('update');
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
  if (row !== undefined) return true;
  // A caller with no customer gets no activity: an earlier turn of this conversation whose take_message with urgent
  // true succeeded is the durable record (every texts.ts run and every relay session builds a fresh state). A failed
  // one sent nothing, so a retry must still send (redacted rows keep ok).
  const [turn] = await tx
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.companyId, ctx.companyId),
        eq(conversationTurns.conversationId, conversationId),
        sql`exists (select 1 from jsonb_array_elements(coalesce(${conversationTurns.toolCalls}, '[]'::jsonb)) e
          where e->>'name' = 'take_message' and e->'input'->>'urgent' = 'true' and e->>'ok' = 'true')`,
      ),
    )
    .limit(1);
  return turn !== undefined;
}
