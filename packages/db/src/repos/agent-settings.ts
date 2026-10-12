import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Agent } from '@roofline/shared';
import { agentSettings } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

export type AgentSettingsRow = { agent: Agent; pausedAt: Date | null; pausedBy: string | null; lastRunNowAt: Date | null };

const RUN_NOW_GAP_MS = 5 * 60_000;

const toRow = (r: typeof agentSettings.$inferSelect): AgentSettingsRow => ({
  agent: r.agent,
  pausedAt: r.pausedAt,
  pausedBy: r.pausedBy,
  lastRunNowAt: r.lastRunNowAt,
});

/** The company's settings row for the agent, or null when none (agent is on). */
export async function getAgentSettings(tx: Tx, ctx: TenantContext, agent: Agent): Promise<AgentSettingsRow | null> {
  const [row] = await tx
    .select()
    .from(agentSettings)
    .where(and(eq(agentSettings.companyId, ctx.companyId), eq(agentSettings.agent, agent)));
  return row ? toRow(row) : null;
}

/** Upserts the row: paused=true sets paused_at=now, paused_by=ctx.userId; false clears both. Returns the row. */
export async function setPaused(tx: Tx, ctx: TenantContext, agent: Agent, paused: boolean, now: Date): Promise<AgentSettingsRow> {
  const pausedAt = paused ? now : null;
  const pausedBy = paused ? ctx.userId : null;
  const [row] = await tx
    .insert(agentSettings)
    .values({ companyId: ctx.companyId, agent, pausedAt, pausedBy, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [agentSettings.companyId, agentSettings.agent],
      set: { pausedAt, pausedBy, updatedAt: now },
    })
    .returning();
  return toRow(row!);
}

/** True when the agent's row has paused_at set. No row means false. The one-line check S1/D1 call. */
export async function isAgentPaused(tx: Tx, ctx: TenantContext, agent: Agent): Promise<boolean> {
  return (await getAgentSettings(tx, ctx, agent))?.pausedAt != null;
}

/**
 * Atomic 5-minute limit. Upserts the row if missing, then one UPDATE ... SET last_run_now_at = now
 * WHERE (last_run_now_at IS NULL OR last_run_now_at < now - 5 minutes) RETURNING. Two concurrent
 * claims: the second UPDATE waits on the row lock, then re-checks the WHERE and gets nothing.
 */
export async function claimRunNow(
  tx: Tx,
  ctx: TenantContext,
  agent: Agent,
  now: Date,
): Promise<{ claimed: boolean; nextAllowedAt: Date }> {
  await tx.insert(agentSettings).values({ companyId: ctx.companyId, agent }).onConflictDoNothing();
  const threshold = new Date(now.getTime() - RUN_NOW_GAP_MS);
  const claimed = await tx
    .update(agentSettings)
    .set({ lastRunNowAt: now, updatedAt: now })
    .where(
      and(
        eq(agentSettings.companyId, ctx.companyId),
        eq(agentSettings.agent, agent),
        or(isNull(agentSettings.lastRunNowAt), lt(agentSettings.lastRunNowAt, threshold)),
      ),
    )
    .returning({ lastRunNowAt: agentSettings.lastRunNowAt });
  if (claimed.length > 0) return { claimed: true, nextAllowedAt: new Date(now.getTime() + RUN_NOW_GAP_MS) };
  const current = await getAgentSettings(tx, ctx, agent);
  const last = current?.lastRunNowAt ?? now;
  return { claimed: false, nextAllowedAt: new Date(last.getTime() + RUN_NOW_GAP_MS) };
}
