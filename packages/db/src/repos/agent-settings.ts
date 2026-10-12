import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { G1_AGENTS, isPaused, type Agent } from '@roofline/shared';
import { agentSettings, companies } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

export type AgentSettingsRow = { agent: Agent; pausedAt: Date | null; pausedBy: string | null; lastRunNowAt: Date | null };

const RUN_NOW_GAP_MS = 5 * 60_000;

const toRow = (r: typeof agentSettings.$inferSelect): AgentSettingsRow => ({
  agent: r.agent,
  pausedAt: r.pausedAt,
  pausedBy: r.pausedBy,
  lastRunNowAt: r.lastRunNowAt,
});

/** The company's settings row for the agent, or null when none (isPaused says what that means: a launch agent is on, a G1 agent is paused). */
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

/** True when the agent is paused by the one pause rule (isPaused): a row with paused_at set, or no row for a G1 agent. */
export async function isAgentPaused(tx: Tx, ctx: TenantContext, agent: Agent): Promise<boolean> {
  return isPaused(agent, await getAgentSettings(tx, ctx, agent));
}

/** Ruling GX-E: a G1 agent runs when the company may run agents (active or trial) and the agent is not paused. */
export async function g1AgentOn(tx: Tx, ctx: TenantContext, agent: Agent): Promise<boolean> {
  const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  if (!company || (company.status !== 'active' && company.status !== 'trial')) return false;
  return !(await isAgentPaused(tx, ctx, agent));
}

/**
 * Atomic 5-minute limit. Upserts the row if missing, then one UPDATE ... SET last_run_now_at = now
 * WHERE (last_run_now_at IS NULL OR last_run_now_at < now - 5 minutes) RETURNING. Two concurrent
 * claims: the second UPDATE waits on the row lock, then re-checks the WHERE and gets nothing.
 * A missing row is inserted paused for a G1 agent (it must not turn on by running), unpaused for a launch agent;
 * an existing row is never changed by the insert.
 */
export async function claimRunNow(
  tx: Tx,
  ctx: TenantContext,
  agent: Agent,
  now: Date,
): Promise<{ claimed: boolean; nextAllowedAt: Date }> {
  const pausedAt = (G1_AGENTS as readonly string[]).includes(agent) ? now : null;
  await tx.insert(agentSettings).values({ companyId: ctx.companyId, agent, pausedAt }).onConflictDoNothing();
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
