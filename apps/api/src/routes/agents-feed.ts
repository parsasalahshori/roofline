import { Router } from 'express';
import { feedRank, listFeedPage, listFrontDeskFollowUps, listWaitingTasks, withTenant, type FeedCursor, type FeedRow, type TenantContext, type Tx } from '@roofline/db';
import type { FeedItem, FeedPage, ScreenAgent, WaitingItem, WaitingList, WaitingOn } from '@roofline/shared';
import { isScreenAgent } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { feedSentence, waitingAttentionText, waitingDraftText } from '../agents/feed-text.ts';
import { can, type Capability } from '../permissions.ts';
import { AppError } from '../errors.ts';
import { canReview } from '../tasks/service.ts';
import { UUID } from '../validate.ts';

/** Feed rows per page. */
export const FEED_PAGE_SIZE = 30;

const BAD_AGENT = 'Please pick a valid agent.';
const BAD_CURSOR = 'Please reload the page and try again.';

/** The approval capability each draft's class needs. */
const CLASS_CAPABILITY = {
  message: 'approve_message',
  internal: 'approve_internal',
  spend: 'approve_spend',
} as const satisfies Record<'message' | 'internal' | 'spend', Capability>;

/** An opaque cursor: base64url of `${at ISO}|${rank}|${id}`. */
export function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.rank}|${cursor.id}`, 'utf8').toString('base64url');
}

/** Reads a cursor back, or throws the 400 for a cursor this server did not make. */
export function decodeCursor(value: string): FeedCursor {
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const parts = text.split('|');
  const [atText = '', rankText = '', id = ''] = parts;
  const at = new Date(atText);
  const rank = /^[1-3]$/.test(rankText) ? Number(rankText) : Number.NaN;
  if (parts.length !== 3 || Number.isNaN(at.getTime()) || Number.isNaN(rank) || !UUID.test(id)) {
    throw new AppError(400, BAD_CURSOR, 'cursor');
  }
  return { at, rank, id };
}

/** A string query parameter, or undefined when it is absent. Anything else is a bad value. */
function stringParam(value: unknown, message: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError(400, message, field);
  return value;
}

const isOpenDraft = (status: string) => status === 'draft' || status === 'awaiting_owner';

/** The job a row is about, as a link, else null. */
function jobHref(subjectType: string | null, subjectId: string | null): string | null {
  return subjectType === 'job' && subjectId !== null ? `/jobs/${subjectId}` : null;
}

/** Where a feed row links: the review for a draft the reader can review, else its job, else nowhere. */
function feedHref(row: FeedRow, ctx: TenantContext): string | null {
  if (canReview(ctx) && isOpenDraft(row.taskStatus)) return `/approvals/${row.taskId}`;
  return jobHref(row.subjectType, row.subjectId);
}

function toFeedItem(row: FeedRow, ctx: TenantContext): FeedItem {
  return {
    id: row.id,
    agent: row.agent,
    kind: row.kind,
    text: feedSentence(row),
    at: row.at.toISOString(),
    href: feedHref(row, ctx),
  };
}

/**
 * Who a draft waits on: the reader when they may approve one of its classes, else the office.
 * A draft with no open steps waits on the office too.
 */
function draftWaitingOn(
  row: { status: string; ownerName: string | null; approvalClasses: readonly ('message' | 'internal' | 'spend')[] },
  ctx: TenantContext,
): WaitingOn {
  const classes = row.approvalClasses;
  const owner: WaitingOn = row.ownerName !== null ? { kind: 'person', name: row.ownerName } : { kind: 'office' };
  // Spend steps already forwarded to the owner wait on the owner.
  if (row.status === 'awaiting_owner') return owner;
  if (classes.length === 0) return canReview(ctx) ? { kind: 'you' } : { kind: 'office' };
  if (classes.some((cls) => can(ctx, CLASS_CAPABILITY[cls]))) return { kind: 'you' };
  // Only spend is open and the reader may not approve it: it is the owner's.
  if (classes.every((cls) => cls === 'spend')) return owner;
  return { kind: 'office' };
}

/** Attention tasks wait on the owner or the office; a rep's are the office's to pick up. */
const attentionWaitingOn = (ctx: TenantContext): WaitingOn => (ctx.role === 'rep' ? { kind: 'office' } : { kind: 'you' });

/** Who a Front Desk job task waits on: the job's assignee ('you' when it is the reader), else the office. */
function jobAssigneeWaitingOn(row: { jobAssignedUserId: string | null; jobAssigneeName: string | null }, ctx: TenantContext): WaitingOn {
  if (row.jobAssignedUserId === null) return { kind: 'office' };
  if (ctx.userId !== undefined && ctx.userId === row.jobAssignedUserId) return { kind: 'you' };
  return row.jobAssigneeName !== null ? { kind: 'person', name: row.jobAssigneeName } : { kind: 'office' };
}

/**
 * Front Desk follow-ups: jobs whose customer left a message or was handed to the team and whose next step
 * is still open (the repo's rule, scoped by jobScope for reps). Each waits on the person the job is
 * assigned to, the reader when that is them, else the office.
 */
async function frontDeskFollowUps(tx: Tx, ctx: TenantContext, now: Date): Promise<WaitingItem[]> {
  const rows = await listFrontDeskFollowUps(tx, ctx, now);
  return rows.map((row): WaitingItem => {
    const who = row.outcome === 'transferred' ? 'A caller was handed to the team.' : 'A caller left a message.';
    let waitingOn: WaitingOn = { kind: 'office' };
    if (row.assigneeName !== null) {
      waitingOn = ctx.userId !== undefined && ctx.userId === row.assignedUserId ? { kind: 'you' } : { kind: 'person', name: row.assigneeName };
    }
    return {
      id: `fd-follow-up:${row.jobId}`,
      agent: 'front_desk',
      kind: 'front_desk_follow_up',
      text: `${who} Next step: ${row.nextStep}`,
      since: row.since.toISOString(),
      waitingOn,
      href: jobHref('job', row.jobId),
    };
  });
}

/**
 * `/api/agents`: the activity feed and the waiting-on-a-person list (the Agents screen).
 * - `GET /feed?agent=&cursor=` one page of the feed, newest first, 30 rows; `nextCursor` is null on the last page.
 * - `GET /waiting` drafts waiting for approval, tasks that need attention, and Front Desk follow-ups,
 *   oldest first, with who each one waits on.
 * Reps see only events and tasks on their own jobs and customers (Ruling AX-J).
 */
export function agentsFeedRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/feed', async (req, res) => {
    const { ctx } = req;
    const agentValue = stringParam(req.query.agent, BAD_AGENT, 'agent');
    let agent: ScreenAgent | undefined;
    if (agentValue !== undefined) {
      if (!isScreenAgent(agentValue)) throw new AppError(400, BAD_AGENT, 'agent');
      agent = agentValue;
    }
    const cursorValue = stringParam(req.query.cursor, BAD_CURSOR, 'cursor');
    const cursor = cursorValue === undefined || cursorValue === '' ? null : decodeCursor(cursorValue);

    const rows = await withTenant(pools, ctx, (tx) =>
      listFeedPage(tx, ctx, {
        ...(agent !== undefined && { agent }),
        cursor,
        limit: FEED_PAGE_SIZE + 1,
      }),
    );

    const kept = rows.slice(0, FEED_PAGE_SIZE);
    const last = kept[kept.length - 1];
    const nextCursor = rows.length > FEED_PAGE_SIZE && last ? encodeCursor({ at: last.at, rank: feedRank(last.kind), id: last.id }) : null;
    const page: FeedPage = { items: kept.map((row) => toFeedItem(row, ctx)), nextCursor };
    res.json(page);
  });

  router.get('/waiting', async (req, res) => {
    const { ctx } = req;
    const now = clock.now();
    const items = await withTenant(pools, ctx, async (tx): Promise<WaitingItem[]> => {
      const rows = await listWaitingTasks(tx, ctx, now);
      const tasks = rows.map((row): WaitingItem => {
        if (row.waiting === 'draft') {
          return {
            id: row.taskId,
            agent: row.agent,
            kind: 'draft',
            text: waitingDraftText(row.agent, row.title),
            since: row.since.toISOString(),
            waitingOn: draftWaitingOn(row, ctx),
            href: canReview(ctx) ? `/approvals/${row.taskId}` : jobHref(row.subjectType, row.subjectId),
          };
        }
        // A Front Desk task on a job waits on the job's assignee (the reader when that is them), else the office,
        // and shows the job's next step like a follow-up row does.
        const onJob = row.agent === 'front_desk' && row.subjectType === 'job';
        let text = waitingAttentionText(row.agent, row.title, row.reason);
        if (onJob && row.jobNextStep !== null && row.jobNextStep.trim() !== '') text += ` Next step: ${row.jobNextStep}`;
        return {
          id: row.taskId,
          agent: row.agent,
          kind: 'attention',
          text,
          since: row.since.toISOString(),
          waitingOn: onJob ? jobAssigneeWaitingOn(row, ctx) : attentionWaitingOn(ctx),
          href: jobHref(row.subjectType, row.subjectId),
        };
      });
      const followUps = await frontDeskFollowUps(tx, ctx, now);
      return [...tasks, ...followUps].sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.id.localeCompare(b.id));
    });
    const list: WaitingList = { items };
    res.json(list);
  });

  return router;
}
