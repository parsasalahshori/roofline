import { and, desc, eq, ne, sql } from 'drizzle-orm';
import {
  agentTasks,
  type ClaimPatch,
  claims,
  companies,
  followUpLogFor,
  g1AgentOn,
  jobs,
  messages,
  saveClaim,
  type TenantContext,
  type Tx,
  withTenant,
} from '@roofline/db';
import { canMoveClaim } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import { type ClaimReplyFacts, LlmUnavailableError } from '../../providers/llm.ts';
import { createTask } from '../../tasks/service.ts';
import { writeAgentNote } from '../notes.ts';

export type ClaimsReplyMessage = {
  companyId: string;
  customerId: string;
  messageId: string;
  body: string;
  receivedAt: Date;
};

/*
 * The Claims agent's look at a homeowner's reply (G1 Task 8, Ruling GX-A). `onClaimsReply` is the
 * hook's quick, in-transaction check; the work happens in the `claims-reply` job (`runClaimsReply`):
 * Claude reads the text, the claim is updated at once (a person can change it back on the claim
 * screen), a live note records what changed, and a date for the adjuster drafts a booking for
 * approval. The job sends no text, and nothing here logs the message's text.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A reply counts when the customer had a claims text in this many days. */
const REPLY_WINDOW_DAYS = 7;
const ADJUSTER_VISIT_MINUTES = 60;
const NOTE_KIND = 'claims_reply_noted';
const VISIT_KIND = 'claims_adjuster_visit';
const FROM_THE_TEXT = "From the homeowner's text";
const SHORT = 40;
/** Seconds the claims-reply job waits, so the webhook transaction that stored the message has committed first. */
const REPLY_JOB_DELAY_SECONDS = 5;

const systemCtx = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

/** The customer's newest claim that is not closed, or null. */
async function openClaimOf(tx: Tx, ctx: TenantContext, customerId: string) {
  const [row] = await tx
    .select({
      claimId: claims.id,
      jobId: claims.jobId,
      status: claims.status,
      claimNumber: claims.claimNumber,
      insurer: claims.insurer,
      repUserId: jobs.assignedUserId,
    })
    .from(claims)
    .innerJoin(jobs, and(eq(jobs.id, claims.jobId), eq(jobs.companyId, ctx.companyId)))
    .where(and(eq(claims.companyId, ctx.companyId), eq(jobs.customerId, customerId), ne(claims.status, 'closed')))
    .orderBy(desc(claims.createdAt), desc(claims.id))
    .limit(1);
  return row ?? null;
}

/**
 * The hook's call: when the customer had a `claims` follow-up text in the last 7 days and has a claim
 * that is not closed, sends the `claims-reply` job. Always `{ consumed: false }`: the reply goes on to
 * the people in the inbox (and to Front Desk once D1 Task 14 lands). Never throws for ordinary input.
 */
export async function onClaimsReply(tx: Tx, deps: AppDeps, msg: ClaimsReplyMessage): Promise<{ consumed: boolean }> {
  try {
    const ctx = systemCtx(msg.companyId);
    const since = new Date(msg.receivedAt.getTime() - REPLY_WINDOW_DAYS * DAY_MS);
    const log = await followUpLogFor(tx, ctx, [msg.customerId], since);
    if (!log.some((r) => r.kind === 'claims')) return { consumed: false };
    if ((await openClaimOf(tx, ctx, msg.customerId)) === null) return { consumed: false };
    await deps.jobs.send('claims-reply', { companyId: msg.companyId, messageId: msg.messageId }, { singletonKey: msg.messageId, startAfter: REPLY_JOB_DELAY_SECONDS });
  } catch {
    // Ordinary errors are swallowed: a throw here would roll the message back. Nothing is logged, so no text can leak.
  }
  return { consumed: false };
}

type LoadedReply = { text: string; customerId: string; timeZone: string };

/** The inbound message's text and customer, and the company's zone; null when there is no such inbound message from a customer. */
async function loadReply(tx: Tx, ctx: TenantContext, messageId: string): Promise<LoadedReply | null> {
  const [msg] = await tx
    .select({ body: messages.body, customerId: messages.customerId, direction: messages.direction })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.id, messageId)))
    .limit(1);
  if (!msg || msg.direction !== 'in' || msg.customerId === null) return null;
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return { text: msg.body, customerId: msg.customerId, timeZone: company?.timezone ?? 'America/Chicago' };
}

/** The job's rep, else the company's owner; null when neither can be found. */
async function visitUserId(tx: Tx, repUserId: string | null): Promise<string | null> {
  if (repUserId !== null) return repUserId;
  // company_members is the security-barrier view filtered to the current company (app.company_id).
  const result = await tx.execute(sql`select user_id from company_members where role = 'owner' and status = 'active' order by id limit 1`);
  const row = result.rows[0];
  return row ? (row.user_id as string) : null;
}

const DECISION_WORDS = { approved: 'approved', partly_approved: 'partly approved', denied: 'denied' } as const;

/** The live note's title: what the agent wrote down, in the order a person cares about. */
function noteTitle(facts: ClaimReplyFacts, applied: ClaimPatch): string {
  if (typeof applied.claimNumber === 'string') return `Claims noted claim number ${applied.claimNumber.slice(0, SHORT)}`;
  if (facts.adjusterAt !== undefined) return 'Claims noted the adjuster visit';
  if (applied.insurer !== undefined) return 'Claims noted the insurer';
  if (applied.status !== undefined && facts.decision !== undefined) return `Claims noted the claim was ${DECISION_WORDS[facts.decision]}`;
  return 'Claims noted a claim update';
}

/** Records what the agent changed as a finished live note (Ruling GX-R): it never waits for an approval. */
async function writeLiveNote(tx: Tx, ctx: TenantContext, messageId: string, title: string, now: Date): Promise<void> {
  await writeAgentNote(
    tx,
    ctx,
    { agent: 'claims', kind: NOTE_KIND, title, summary: FROM_THE_TEXT, subjectType: 'message', subjectId: messageId, label: title },
    now,
  );
}

/**
 * The `claims-reply` job: reads the reply with Claude and records what it says. Stops quietly when
 * the model is unavailable (the reply still reaches people in the inbox). Sends no text.
 */
export async function runClaimsReply(deps: AppDeps, companyId: string, messageId: string): Promise<void> {
  const ctx = systemCtx(companyId);
  const loaded = await withTenant(deps.pools, ctx, async (tx) => ((await g1AgentOn(tx, ctx, 'claims')) ? loadReply(tx, ctx, messageId) : null));
  if (loaded === null) return;

  // The model is called outside any transaction.
  let facts: ClaimReplyFacts;
  try {
    facts = (await deps.llm.extractClaimReply({ text: loaded.text, now: deps.clock.now(), timeZone: loaded.timeZone })).facts;
  } catch (err) {
    if (err instanceof LlmUnavailableError) return;
    throw err;
  }

  const now = deps.clock.now();
  await withTenant(deps.pools, ctx, async (tx) => {
    // One set of notes per message: a rerun of the job finds the first run's task and stops.
    const [done] = await tx
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.companyId, ctx.companyId),
          eq(agentTasks.agent, 'claims'),
          eq(agentTasks.subjectType, 'message'),
          eq(agentTasks.subjectId, messageId),
        ),
      )
      .limit(1);
    if (done) return;

    const claim = await openClaimOf(tx, ctx, loaded.customerId);
    if (claim === null) return;

    const patch: ClaimPatch = {};
    const number = facts.claimNumber?.trim();
    if (number && number !== claim.claimNumber) patch.claimNumber = number;
    const insurer = facts.insurer?.trim();
    if (insurer && insurer !== claim.insurer) patch.insurer = insurer;
    if (facts.decision !== undefined && canMoveClaim(claim.status, facts.decision)) patch.status = facts.decision;

    const visitAt = facts.adjusterAt !== undefined ? new Date(facts.adjusterAt) : null;
    const visit = visitAt !== null && Number.isFinite(visitAt.getTime()) && visitAt.getTime() > now.getTime() ? visitAt : null;

    if (Object.keys(patch).length > 0) await saveClaim(tx, ctx, claim.jobId, patch, { actor: 'agent', userId: null }, now);

    if (Object.keys(patch).length === 0 && visit === null) return;

    // D1 T14: queueFrontDeskText(...) goes here: "Thanks, got it." once the extraction fully answered the reply.
    await writeLiveNote(tx, ctx, messageId, noteTitle(facts, patch), now);

    if (visit !== null) {
      const userId = await visitUserId(tx, claim.repUserId);
      if (userId === null) return;
      await createTask(
        tx,
        ctx,
        {
          agent: 'claims',
          kind: VISIT_KIND,
          title: 'Book the adjuster visit',
          summary: 'The homeowner said when the adjuster is coming.',
          subjectType: 'message',
          subjectId: messageId,
          mode: 'needs_approval',
          expiresAt: visit,
          steps: [
            {
              type: 'create_appointment',
              payload: {
                jobId: claim.jobId,
                kind: 'adjuster',
                start: visit.toISOString(),
                end: new Date(visit.getTime() + ADJUSTER_VISIT_MINUTES * 60_000).toISOString(),
                userId,
                note: FROM_THE_TEXT,
              },
            },
          ],
        },
        { now, allowInternalStepTypes: true },
      );
    }
  });
}
