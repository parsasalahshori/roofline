import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { jobs, type TenantContext, type Tx } from '@roofline/db';
import { addToLiveTask, closeLiveTasksForSubject, createLiveTask } from '../tasks/service.ts';
import { FRONT_DESK_UNIT_WORDS } from './feed-text.ts';

/*
 * A1 Task 4. Front Desk live tasks: one per finished call / text conversation, made through tasks/service.ts only.
 * Never puts phone numbers, names or transcript text in a task.
 */

const CALL_TITLES: Record<string, string> = { message: 'Took a message', transferred: 'Transferred a call' };

/** The customer's most recently updated open job that still has a next step, or null. */
async function openFollowUpJobId(tx: Tx, ctx: TenantContext, customerId: string): Promise<string | null> {
  const rows = await tx
    .select({ id: jobs.id, nextStep: jobs.nextStep })
    .from(jobs)
    .where(and(eq(jobs.companyId, ctx.companyId), eq(jobs.customerId, customerId), isNull(jobs.archivedAt), isNotNull(jobs.nextStep)))
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .limit(5);
  return rows.find((r) => (r.nextStep ?? '').trim() !== '')?.id ?? null;
}

/** Records one live task for a finished call. Idempotent on the call id. Returns the task id. */
export async function recordCallTask(
  tx: Tx,
  ctx: TenantContext,
  input: { callId: string; conversationId: string | null; customerId: string | null; seconds: number; bookings: number; spam: boolean; outcome: string | null },
  now: Date,
): Promise<string | null> {
  let title = 'Answered a call';
  if (input.spam) title = 'Spam call blocked';
  else if (input.outcome !== null && CALL_TITLES[input.outcome] !== undefined) title = CALL_TITLES[input.outcome]!;

  let subjectType: string | undefined;
  let subjectId: string | undefined;
  let status: 'done' | 'needs_attention' = 'done';
  if (!input.spam && (input.outcome === 'message' || input.outcome === 'transferred') && input.customerId !== null) {
    const jobId = await openFollowUpJobId(tx, ctx, input.customerId);
    if (jobId !== null) {
      subjectType = 'job';
      subjectId = jobId;
      status = 'needs_attention';
    }
  }
  if (subjectId === undefined && input.customerId !== null) {
    subjectType = 'customer';
    subjectId = input.customerId;
  }

  const { taskId } = await createLiveTask(
    tx,
    ctx,
    {
      agent: 'front_desk',
      kind: 'call',
      title,
      ...(subjectType !== undefined && subjectId !== undefined && { subjectType, subjectId }),
      step: {
        type: 'front_desk_call',
        result: { seconds: Math.max(0, Math.round(input.seconds)), bookings: input.bookings, spam: input.spam ? 1 : 0 },
      },
      status,
      idempotencyKey: `fd-call:${input.callId}`,
    },
    now,
  );
  return taskId;
}

/** The task title for a text conversation: counted once there are replies, plain at zero. */
function textsTitle(replies: number): string {
  const n = Math.max(0, Math.round(replies));
  const w = FRONT_DESK_UNIT_WORDS.front_desk_texts;
  return n > 0 ? `Answered ${n} ${n === 1 ? w.one : w.many}` : 'Answered texts';
}

/** Records one live task for a text conversation on its company-local day. Idempotent per conversation per day. */
export async function recordTextTask(
  tx: Tx,
  ctx: TenantContext,
  input: { conversationId: string; customerId: string | null; replies: number; bookings: number },
  now: Date,
  timeZone: string,
): Promise<string | null> {
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const key = `fd-texts:${input.conversationId}:${localDay}`;
  const { taskId, created } = await createLiveTask(
    tx,
    ctx,
    {
      agent: 'front_desk',
      kind: 'text_conversation',
      title: textsTitle(input.replies),
      ...(input.customerId !== null && { subjectType: 'customer', subjectId: input.customerId }),
      step: { type: 'front_desk_texts', result: { replies: input.replies, bookings: input.bookings } },
      status: 'done',
      idempotencyKey: key,
    },
    now,
  );
  if (!created) {
    await addToLiveTask(tx, ctx, key, { replies: input.replies, bookings: input.bookings }, now, (r) => textsTitle(Number(r.replies) || 0));
  }
  return taskId;
}

/**
 * Called after a job's next step changed: closes its open Front Desk live tasks when the job now has no next step,
 * or (when `before` is given) when the next step text was changed to something else.
 */
export async function onJobNextStepChanged(
  tx: Tx,
  ctx: TenantContext,
  job: { id: string; nextStep: string | null },
  now: Date,
  before?: string | null,
): Promise<void> {
  const after = (job.nextStep ?? '').trim();
  const changed = before !== undefined && (before ?? '').trim() !== after;
  if (after === '' || changed) {
    await closeLiveTasksForSubject(tx, ctx, 'job', job.id, now);
  }
}
