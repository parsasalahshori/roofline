import type { Agent } from '@roofline/shared';
import { and, eq, gt, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { agentTasks, agentTaskSteps, conversations, customers, jobs } from '../schema/index.ts';
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
  /** The task's status (draft, awaiting_owner or needs_attention). */
  status: string;
  /** Full name of the company's owner (company_members, role 'owner'); null when there is none. */
  ownerName: string | null;
};

const DRAFT_STATUSES = ['draft', 'awaiting_owner'] as const;

/**
 * The one rule for "waits on a person", shared by the waiting list and the card counts: a draft that has
 * not expired, or an awaiting_owner / needs_attention task (those two ignore expires_at).
 */
export function waitingNow(now: Date): SQL {
  return or(
    and(eq(agentTasks.status, 'draft'), or(isNull(agentTasks.expiresAt), gt(agentTasks.expiresAt, now))),
    inArray(agentTasks.status, ['awaiting_owner', 'needs_attention']),
  )!;
}
const OPEN_STEP_STATUSES = ['pending', 'awaiting_owner'] as const;

/**
 * Drafts and attention tasks, oldest `since` first, scoped like the feed (reps: own jobs/customers only).
 * A rep's scope (Ruling AX-J): a 'job' subject inside jobScope(ctx), or a 'customer' subject inside
 * customerScope(ctx). A task with no subject is invisible to a rep.
 */
export async function listWaitingTasks(tx: Tx, ctx: TenantContext, now: Date): Promise<WaitingTaskRow[]> {
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
    .where(and(eq(agentTasks.companyId, ctx.companyId), waitingNow(now), repScope))
    .orderBy(agentTasks.createdAt, agentTasks.id);

  if (tasks.length === 0) return [];

  // company_members is the only way the tenant role sees names; the view is already limited to this company.
  const ownerResult = await tx.execute(
    sql`select name from company_members where role = 'owner' and status = 'active' order by id limit 1`,
  );
  const ownerName = (ownerResult.rows[0]?.name as string | null | undefined) ?? null;

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
      status: task.status,
      ownerName,
    });
  }

  rows.sort((a, b) => a.since.getTime() - b.since.getTime() || a.taskId.localeCompare(b.taskId));
  return rows;
}

/*
 * Front Desk follow-ups: open next steps on jobs whose customer left a message or was handed to the team.
 * D1 has no follow-up table and no conversation-to-job link, so a follow-up is a job with a next step still
 * set whose customer has a Front Desk conversation that ended as a message or a transfer.
 */
export type FrontDeskFollowUpRow = {
  /** The job id (the WaitingItem id is `fd-follow-up:<jobId>`). */
  jobId: string;
  /** Conversation lastMessageAt: when the person started waiting. */
  since: Date;
  /** jobs.next_step text. */
  nextStep: string;
  /** Assigned user's name (company_members), else null = the office. */
  assigneeName: string | null;
  /** The assigned user, else null. */
  assignedUserId: string | null;
  /** 'message' or 'transferred' (conversations.outcome). */
  outcome: string;
};

/** The newest message or transfer conversation of the job's customer since `since30`, as a correlated subquery over `column`. */
function latestConversation(column: 'last_message_at' | 'outcome', since30: Date): SQL {
  return sql`(select c.${sql.raw(column)} from ${conversations} c
    where c.company_id = ${jobs.companyId} and c.customer_id = ${jobs.customerId}
      and c.outcome in ('message', 'transferred')
      and c.last_message_at >= ${since30}
    order by c.last_message_at desc, c.id desc limit 1)`;
}

/** The one query behind both the list and the card count, so they always agree. */
function followUpQuery(tx: Tx, ctx: TenantContext, now: Date) {
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const since = latestConversation('last_message_at', since30);
  return tx
    .select({
      jobId: jobs.id,
      since: sql<Date>`${since}`.mapWith((value: string | Date) => new Date(value)).as('since'),
      nextStep: jobs.nextStep,
      assignedUserId: jobs.assignedUserId,
      // company_members is the only way the tenant role sees names (no grant on users).
      assigneeName: sql<string | null>`(select m.name from company_members m where m.user_id = ${jobs.assignedUserId} limit 1)`,
      outcome: sql<string>`${latestConversation('outcome', since30)}`,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.companyId, ctx.companyId),
        isNotNull(jobs.nextStep),
        isNull(jobs.archivedAt),
        sql`${since} is not null`,
        jobScope(ctx),
      ),
    );
}

/** Open Front Desk follow-ups (last message or transfer in the 30 days before now), rep-scoped by jobScope(ctx), oldest first. */
export async function listFrontDeskFollowUps(tx: Tx, ctx: TenantContext, now: Date): Promise<FrontDeskFollowUpRow[]> {
  const rows = await followUpQuery(tx, ctx, now).orderBy(sql`since asc`, jobs.id);
  return rows.map((row) => ({
    jobId: row.jobId,
    since: row.since,
    nextStep: row.nextStep ?? '',
    assigneeName: row.assigneeName ?? null,
    assignedUserId: row.assignedUserId,
    outcome: row.outcome,
  }));
}

/** Same rule as the list (last message or transfer in the 30 days before now; shared query), counted: feeds the front_desk card waitingCount. */
export async function countFrontDeskFollowUps(tx: Tx, ctx: TenantContext, now: Date): Promise<number> {
  return (await followUpQuery(tx, ctx, now)).length;
}
