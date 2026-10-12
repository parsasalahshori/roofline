import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { agentTaskEvents } from '../schema/index.ts';
import type { ACTOR_TYPES, AGENT_EVENT_KINDS } from '../schema/enums.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * The agents feed: one row per thing that happened to a task. Rows are only inserted, never
 * updated or deleted. Every query names the company as well as relying on row-level security.
 */

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
export type ActorType = (typeof ACTOR_TYPES)[number];
export type AgentEventRow = typeof agentTaskEvents.$inferSelect;

export type NewAgentEvent = {
  taskId: string;
  stepId?: string | null;
  kind: AgentEventKind;
  actorType: ActorType;
  actorUserId?: string | null;
  data?: Record<string, unknown>;
  at: Date;
};

/**
 * Writes one event and returns it. `data` holds counts and ids only, never message text or
 * names. Only `tasks/service.ts` in apps/api calls this, in the same transaction as the
 * transition the event records.
 */
export async function insertAgentEvent(tx: Tx, ctx: TenantContext, event: NewAgentEvent): Promise<AgentEventRow> {
  const [row] = await tx
    .insert(agentTaskEvents)
    .values({
      companyId: ctx.companyId,
      taskId: event.taskId,
      stepId: event.stepId ?? null,
      kind: event.kind,
      actorType: event.actorType,
      actorUserId: event.actorUserId ?? null,
      data: event.data ?? {},
      at: event.at,
    })
    .returning();
  return row!;
}

/** Whether the task already has an event of this kind. */
export async function hasTaskEvent(tx: Tx, ctx: TenantContext, taskId: string, kind: AgentEventKind): Promise<boolean> {
  const rows = await tx
    .select({ id: agentTaskEvents.id })
    .from(agentTaskEvents)
    .where(and(eq(agentTaskEvents.companyId, ctx.companyId), eq(agentTaskEvents.taskId, taskId), eq(agentTaskEvents.kind, kind)))
    .limit(1);
  return rows.length > 0;
}

/** One task's events, oldest first. */
export async function listTaskEvents(tx: Tx, ctx: TenantContext, taskId: string): Promise<AgentEventRow[]> {
  return tx
    .select()
    .from(agentTaskEvents)
    .where(and(eq(agentTaskEvents.companyId, ctx.companyId), eq(agentTaskEvents.taskId, taskId)))
    .orderBy(asc(agentTaskEvents.at), asc(agentTaskEvents.id));
}

/** The company's newest events first; `before` pages backwards; `limit` defaults to 50 and is clamped to 1..200. */
export async function listRecentEvents(
  tx: Tx,
  ctx: TenantContext,
  options: { limit?: number; before?: Date } = {},
): Promise<AgentEventRow[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  const where = options.before
    ? and(eq(agentTaskEvents.companyId, ctx.companyId), lt(agentTaskEvents.at, options.before))
    : eq(agentTaskEvents.companyId, ctx.companyId);
  return tx.select().from(agentTaskEvents).where(where).orderBy(desc(agentTaskEvents.at), desc(agentTaskEvents.id)).limit(limit);
}
