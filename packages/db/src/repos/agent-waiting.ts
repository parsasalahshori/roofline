import type { Agent } from '@roofline/shared';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { agentTasks, agentTaskSteps, customers, jobs } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { customerScope, jobScope } from './scope.ts';

/*
 * Tasks that wait on a person: drafts to approve and tasks that need attention.
 * Every query names the company as well as relying on row-level security.
 */

export type WaitingTaskRow = {
  taskId: string;
  agent: Agent;
  /** 'draft' = status draft or awaiting_owner and not expired; 'attention' = status needs_attention. */
  waiting: 'draft' | 'attention';
  taskKind: string;
  title: string;
  /** createdAt for drafts, updatedAt for attention tasks. */
  since: Date;
  subjectType: string | null;
  subjectId: string | null;
  /** Drafts: approval classes of the task's enabled pending/awaiting_owner steps (distinct). Attention: []. */
  approvalClasses: ('message' | 'internal' | 'spend')[];
  /** Attention: error_plain of the first needs_attention step (by position), else null. Drafts: null. */
  reason: string | null;
};

const DRAFT_STATUSES = ['draft', 'awaiting_owner'] as const;
const OPEN_STEP_STATUSES = ['pending', 'awaiting_owner'] as const;

/**
 * Drafts and attention tasks, oldest `since` first, scoped like the feed (reps: own jobs/customers only).
 * A rep's scope (Ruling AX-J): a 'job' subject inside jobScope(ctx), or a 'customer' subject inside
 * customerScope(ctx). A task with no subject is invisible to a rep.
 */
export async function listWaitingTasks(tx: Tx, ctx: TenantContext, now: Date): Promise<WaitingTaskRow[]> {
  const waitingNow = or(
    and(
      inArray(agentTasks.status, [...DRAFT_STATUSES]),
      or(isNull(agentTasks.expiresAt), gt(agentTasks.expiresAt, now)),
    ),
    eq(agentTasks.status, 'needs_attention'),
  );

  // A rep's subjects must be inside their scope (Ruling AX-J). jobScope and customerScope are only
  // undefined for non-reps, so the `true` fallbacks never narrow anything.
  const repScope =
    ctx.role === 'rep'
      ? or(
          and(
            eq(agentTasks.subjectType, 'job'),
            sql`${agentTasks.subjectId} in (select ${jobs.id} from ${jobs} where ${jobScope(ctx) ?? sql`true`})`,
          ),
          and(
            eq(agentTasks.subjectType, 'customer'),
            sql`${agentTasks.subjectId} in (select ${customers.id} from ${customers} where ${customerScope(ctx) ?? sql`true`})`,
          ),
        )
      : undefined;

  const tasks = await tx
    .select({
      taskId: agentTasks.id,
      agent: agentTasks.agent,
      status: agentTasks.status,
      taskKind: agentTasks.kind,
      title: agentTasks.title,
      createdAt: agentTasks.createdAt,
      updatedAt: agentTasks.updatedAt,
      subjectType: agentTasks.subjectType,
      subjectId: agentTasks.subjectId,
    })
    .from(agentTasks)
    .where(and(eq(agentTasks.companyId, ctx.companyId), waitingNow, repScope))
    .orderBy(agentTasks.createdAt, agentTasks.id);

  if (tasks.length === 0) return [];

  const steps = await tx
    .select({
      taskId: agentTaskSteps.taskId,
      position: agentTaskSteps.position,
      status: agentTaskSteps.status,
      enabled: agentTaskSteps.enabled,
      approvalClass: agentTaskSteps.approvalClass,
      errorPlain: agentTaskSteps.errorPlain,
    })
    .from(agentTaskSteps)
    .where(
      and(
        eq(agentTaskSteps.companyId, ctx.companyId),
        inArray(
          agentTaskSteps.taskId,
          tasks.map((task) => task.taskId),
        ),
      ),
    )
    .orderBy(agentTaskSteps.position);

  const stepsByTask = new Map<string, typeof steps>();
  for (const step of steps) {
    const list = stepsByTask.get(step.taskId);
    if (list) list.push(step);
    else stepsByTask.set(step.taskId, [step]);
  }

  const rows: WaitingTaskRow[] = [];
  for (const task of tasks) {
    const taskSteps = stepsByTask.get(task.taskId) ?? [];
    const isDraft = (DRAFT_STATUSES as readonly string[]).includes(task.status);
    const waiting: WaitingTaskRow['waiting'] = isDraft ? 'draft' : 'attention';

    const approvalClasses: WaitingTaskRow['approvalClasses'] = [];
    if (isDraft) {
      for (const step of taskSteps) {
        if (!step.enabled || !(OPEN_STEP_STATUSES as readonly string[]).includes(step.status)) continue;
        if (!approvalClasses.includes(step.approvalClass)) approvalClasses.push(step.approvalClass);
      }
    }

    let reason: string | null = null;
    if (!isDraft) {
      // Steps come back in position order, so the first needs_attention step is the lowest position.
      const first = taskSteps.find((step) => step.status === 'needs_attention');
      reason = first?.errorPlain ?? null;
    }

    rows.push({
      taskId: task.taskId,
      agent: task.agent,
      waiting,
      taskKind: task.taskKind,
      title: task.title,
      since: isDraft ? task.createdAt : task.updatedAt,
      subjectType: task.subjectType,
      subjectId: task.subjectId,
      approvalClasses,
      reason,
    });
  }

  rows.sort((a, b) => a.since.getTime() - b.since.getTime() || a.taskId.localeCompare(b.taskId));
  return rows;
}
