import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { ActivitySubjectType, Agent, MessageStatus, TimelineItem, TimelinePage } from '@roofline/shared';
import { customers, jobs } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { customerScope, jobScope } from './scope.ts';

/**
 * Who appears in a timeline's actor line for an agent. Mirrors apps/web/src/copy/status.ts
 * (AGENT_LABEL); the web keeps its own copy, the API needs these words for the rows it returns.
 */
export const AGENT_NAMES: Record<Agent, string> = {
  storm_scout: 'Storm Scout',
  estimator: 'Estimator',
  front_desk: 'Front Desk',
  claims: 'Claims',
  scheduler: 'Scheduler',
  follow_up: 'Follow-up',
  system: 'Roofline',
};

/**
 * `before`/`beforeId` is the cursor: items strictly older than (before, beforeId) in the page order
 * (time to the millisecond, then id, both descending). `beforeId` is optional for a plain date.
 */
export type TimelineQuery = { customerId?: string; jobId?: string; before?: Date; beforeId?: string; limit?: number };

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

type Subject = { type: 'customer'; id: string } | { type: 'job'; id: string };

/** Exactly one of customerId or jobId; anything else is a programming error (the route validates first). */
function subjectOf(q: Pick<TimelineQuery, 'customerId' | 'jobId'>): Subject {
  const { customerId, jobId } = q;
  if ((customerId === undefined) === (jobId === undefined)) {
    throw new Error('A timeline needs exactly one of customerId or jobId.');
  }
  if (customerId !== undefined) return { type: 'customer', id: customerId };
  return { type: 'job', id: jobId as string };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Whether the member may see the timeline's subject: a customer they may see (customerScope) or a
 * job they may see (jobScope). Anything else, including another company's id, is not visible.
 */
export async function timelineSubjectVisible(
  tx: Tx,
  ctx: TenantContext,
  q: Pick<TimelineQuery, 'customerId' | 'jobId'>,
): Promise<boolean> {
  const subject = subjectOf(q);
  if (subject.type === 'customer') {
    const [row] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, subject.id), customerScope(ctx)))
      .limit(1);
    return row !== undefined;
  }
  const [row] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, subject.id), jobScope(ctx)))
    .limit(1);
  return row !== undefined;
}

/** One row of the merged query; `item_type` tells an activity from a text. */
type TimelineRow = {
  id: string;
  item_at: Date | string;
  item_type: 'activity' | 'text';
  kind: string;
  summary: string;
  actor_type: string | null;
  actor_agent: string | null;
  actor_name: string | null;
  subject_type: ActivitySubjectType;
  subject_id: string;
  direction: string | null;
  body: string | null;
  status: string | null;
};

type Cursor = { at: string; id: string | null } | null;

/** Rows after the cursor in page order. Times compare to the millisecond, as the cursor carries them. */
const beforeClause = (at: SQL, id: SQL, before: Cursor): SQL => {
  if (before === null) return sql``;
  const ms = sql`date_trunc('milliseconds', ${at})`;
  return before.id === null
    ? sql` and ${ms} < ${before.at}::timestamptz`
    : sql` and (${ms}, ${id}) < (${before.at}::timestamptz, ${before.id}::uuid)`;
};

/** The ids of the jobs the member may see that match `where`. Reps are held to jobScope; the owner and office see all. */
function visibleJobIds(ctx: TenantContext, where: SQL): SQL {
  const scope = jobScope(ctx);
  return sql`select ${jobs.id} from ${jobs} where ${where}${scope === undefined ? sql`` : sql` and ${scope}`}`;
}

/** The customer's activities (on the customer, its addresses and its visible jobs) and its texts. */
function customerTimeline(ctx: TenantContext, customerId: string, before: Cursor, fetch: number): SQL {
  const jobIds = visibleJobIds(ctx, sql`${jobs.customerId} = ${customerId}`);
  const activityArm = sql`
    select a.id, a.at as item_at, 'activity'::text as item_type, a.kind, a.summary,
           a.actor_type, a.actor_agent, cm.name as actor_name,
           a.subject_type, a.subject_id,
           null::text as direction, null::text as body, null::text as status
      from activities a
      left join company_members cm on cm.user_id = a.actor_user_id
     where ((a.subject_type = 'customer' and a.subject_id = ${customerId})
         or (a.subject_type = 'property' and a.subject_id in (select p.id from properties p where p.customer_id = ${customerId}))
         or (a.subject_type = 'job' and a.subject_id in (${jobIds})))
       ${beforeClause(sql`a.at`, sql`a.id`, before)}`;
  const textArm = sql`
    select m.id, coalesce(m.sent_at, m.created_at) as item_at, 'text'::text as item_type,
           case when m.direction = 'in' then 'text.in' else 'text.out' end as kind,
           case when m.direction = 'in' then 'Text received' else 'Text sent' end as summary,
           'system'::text as actor_type, null::text as actor_agent, null::text as actor_name,
           'message'::text as subject_type, m.id as subject_id,
           m.direction, m.body, m.status
      from messages m
     where m.customer_id = ${customerId}
       ${beforeClause(sql`coalesce(m.sent_at, m.created_at)`, sql`m.id`, before)}`;
  return merged(activityArm, textArm, fetch);
}

/** The job's activities (on the job and its address) and the texts about it: from its agent tasks, or to its customer since it was created. */
function jobTimeline(jobId: string, before: Cursor, fetch: number): SQL {
  const activityArm = sql`
    select a.id, a.at as item_at, 'activity'::text as item_type, a.kind, a.summary,
           a.actor_type, a.actor_agent, cm.name as actor_name,
           a.subject_type, a.subject_id,
           null::text as direction, null::text as body, null::text as status
      from activities a
      left join company_members cm on cm.user_id = a.actor_user_id
     where ((a.subject_type = 'job' and a.subject_id = ${jobId})
         or (a.subject_type = 'property' and a.subject_id in (select j.property_id from jobs j where j.id = ${jobId})))
       ${beforeClause(sql`a.at`, sql`a.id`, before)}`;
  const textArm = sql`
    select m.id, coalesce(m.sent_at, m.created_at) as item_at, 'text'::text as item_type,
           case when m.direction = 'in' then 'text.in' else 'text.out' end as kind,
           case when m.direction = 'in' then 'Text received' else 'Text sent' end as summary,
           'system'::text as actor_type, null::text as actor_agent, null::text as actor_name,
           'message'::text as subject_type, m.id as subject_id,
           m.direction, m.body, m.status
      from messages m
     where ((m.step_id in (
              select s.id from agent_task_steps s
                join agent_tasks t on t.id = s.task_id
               where t.subject_type = 'job' and t.subject_id = ${jobId}))
         or (m.customer_id = (select j.customer_id from jobs j where j.id = ${jobId})
             and m.created_at >= (select j.created_at from jobs j where j.id = ${jobId})))
       ${beforeClause(sql`coalesce(m.sent_at, m.created_at)`, sql`m.id`, before)}`;
  return merged(activityArm, textArm, fetch);
}

/** One UNION ALL, newest first to the millisecond (ties broken by id, so the cursor never skips a row), capped at `fetch` rows. */
function merged(activityArm: SQL, textArm: SQL, fetch: number): SQL {
  return sql`
    select * from (${activityArm} union all ${textArm}) t
     order by date_trunc('milliseconds', t.item_at) desc, t.id desc
     limit ${fetch}`;
}

const isoOf = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const AGENT_TYPES = ['user', 'agent', 'system'] as const;

function agentName(value: string | null): string | null {
  return value !== null && Object.hasOwn(AGENT_NAMES, value) ? AGENT_NAMES[value as Agent] : null;
}

function toItem(row: TimelineRow): TimelineItem {
  const at = isoOf(row.item_at);
  if (row.item_type === 'text') {
    return {
      id: row.id,
      at,
      type: 'text',
      kind: row.kind,
      summary: row.summary,
      actor: { type: 'system', name: null },
      subject: { type: 'message', id: row.subject_id },
      text: {
        direction: row.direction === 'in' ? 'in' : 'out',
        body: row.body ?? '',
        status: row.status as MessageStatus,
      },
    };
  }
  const actorType = AGENT_TYPES.find((type) => type === row.actor_type) ?? 'system';
  const actor =
    actorType === 'user'
      ? { type: 'user' as const, name: row.actor_name }
      : actorType === 'agent'
        ? { type: 'agent' as const, name: agentName(row.actor_agent) }
        : { type: 'system' as const, name: null };
  return {
    id: row.id,
    at,
    type: 'activity',
    kind: row.kind,
    summary: row.summary,
    actor,
    subject: { type: row.subject_type, id: row.subject_id },
    text: null,
  };
}

/**
 * A subject's merged timeline, newest first, one page. Pass the previous page's `nextBefore` as
 * `before` for the next one. The caller checks visibility first (`timelineSubjectVisible`); this
 * does not return an empty page for a subject the member may not see.
 */
export async function timelinePage(tx: Tx, ctx: TenantContext, q: TimelineQuery): Promise<TimelinePage> {
  const subject = subjectOf(q);
  if (q.before !== undefined && Number.isNaN(q.before.getTime())) throw new Error('before must be a valid date.');
  const limit = clampLimit(q.limit);
  const before: Cursor = q.before === undefined ? null : { at: q.before.toISOString(), id: q.beforeId ?? null };
  const query =
    subject.type === 'customer'
      ? customerTimeline(ctx, subject.id, before, limit + 1)
      : jobTimeline(subject.id, before, limit + 1);
  const result = await tx.execute(query);
  const rows = result.rows as unknown as TimelineRow[];
  const items = rows.slice(0, limit).map(toItem);
  const last = items.at(-1);
  return {
    items,
    // An opaque cursor: the last item's time and id (`<iso>~<id>`), read back by the timeline route.
    nextBefore: rows.length > limit && last !== undefined ? `${last.at}~${last.id}` : null,
  };
}
