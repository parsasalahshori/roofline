import { agentSettingsInfo, claimRunNow, type TenantContext, type Tx } from '@roofline/db';
import { LAUNCH_AGENTS, type RunNowResult, type ScreenAgent } from '@roofline/shared';
import { AppError } from '../errors.ts';
import type { JobQueue } from '../jobs/queue.ts';

export type RunNowDeps = { jobs: JobQueue };

/**
 * Per-agent "start now" handlers, called AFTER the request transaction commits (the job must not be queued for a claim that rolls back). storm_scout queues the
 * company's storm-match job (the same one the 10-minute scheduler queues).
 */
export const RUN_NOW: Partial<Record<ScreenAgent, (ctx: TenantContext, deps: RunNowDeps) => Promise<void>>> = {
  storm_scout: async (ctx, deps) => {
    await deps.jobs.send('storm-match-company', { companyId: ctx.companyId }, { singletonKey: ctx.companyId });
  },
};

const MINUTE_MS = 60_000;

/**
 * Throws AppError(409, plain sentence) for non-runnable agents and a paused Storm Scout; otherwise claims the
 * 5-minute slot. Returns the result and `send`, which the caller runs once the transaction has committed.
 */
export async function runAgentNow(
  tx: Tx,
  ctx: TenantContext,
  agent: ScreenAgent,
  now: Date,
  deps: RunNowDeps,
): Promise<{ result: RunNowResult; send: () => Promise<void> }> {
  if (agent === 'estimator') throw new AppError(409, 'This agent works when you ask.');
  if (agent === 'front_desk') throw new AppError(409, 'Front Desk answers calls as they come in.');
  if (!(LAUNCH_AGENTS as readonly string[]).includes(agent)) throw new AppError(409, 'This agent is coming soon.');
  const handler = RUN_NOW[agent];
  if (!handler) throw new AppError(409, 'Storm Scout can check for hail once storm alerts are set up.');

  if (agent === 'storm_scout') {
    const rows = await agentSettingsInfo(tx, ctx);
    if (rows.some((r) => r.agent === 'storm_scout' && r.pausedAt !== null)) throw new AppError(409, 'Storm Scout is paused.');
  }

  const claim = await claimRunNow(tx, ctx, agent, now);
  if (!claim.claimed) {
    const minutes = Math.max(1, Math.ceil((claim.nextAllowedAt.getTime() - now.getTime()) / MINUTE_MS));
    throw new AppError(409, `You just ran this. You can run it again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`);
  }
  return {
    result: { started: true, nextAllowedAt: claim.nextAllowedAt.toISOString() },
    send: () => handler(ctx, deps),
  };
}
