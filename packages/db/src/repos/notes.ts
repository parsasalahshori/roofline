import { sql } from 'drizzle-orm';
import type { TimelineItem } from '@roofline/shared';
import { activities } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { timelineSubjectVisible } from './timeline.ts';

/** The longest note, in characters (the route also checks it, so a note is never stored longer). */
export const NOTE_MAX = 2000;

/**
 * Adds a note to a customer's or job's timeline. Returns the timeline line it made, or null when
 * the member may not see the subject (the route answers 404). The note is an activity of kind
 * 'note' whose summary is the note body, in the same transaction as the caller's other work.
 */
export async function addNote(
  tx: Tx,
  ctx: TenantContext,
  n: { subjectType: 'customer' | 'job'; subjectId: string; body: string },
  now: Date,
): Promise<TimelineItem | null> {
  const subject = n.subjectType === 'customer' ? { customerId: n.subjectId } : { jobId: n.subjectId };
  if (!(await timelineSubjectVisible(tx, ctx, subject))) return null;

  const [row] = await tx
    .insert(activities)
    .values({
      companyId: ctx.companyId,
      subjectType: n.subjectType,
      subjectId: n.subjectId,
      kind: 'note',
      summary: n.body,
      actorType: ctx.userId !== null ? 'user' : 'system',
      actorUserId: ctx.userId,
      actorAgent: null,
      at: now,
    })
    .returning();
  if (row === undefined) throw new Error('The note was not saved.');

  let name: string | null = null;
  if (ctx.userId !== null) {
    // company_members is the only way the tenant role sees member names (routes/team.ts).
    const result = await tx.execute(sql`select name from company_members where user_id = ${ctx.userId} limit 1`);
    const member = result.rows[0];
    name = member ? (member.name as string) : null;
  }

  return {
    id: row.id,
    at: row.at.toISOString(),
    type: 'activity',
    kind: 'note',
    summary: n.body,
    actor: ctx.userId !== null ? { type: 'user', name } : { type: 'system', name: null },
    subject: { type: n.subjectType, id: n.subjectId },
    text: null,
  };
}
