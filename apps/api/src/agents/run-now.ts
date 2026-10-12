import { claimRunNow, isAgentPaused, type TenantContext, type Tx } from '@roofline/db';
import { G1_AGENTS, G1_AGENTS_SHIPPED, LAUNCH_AGENTS, type RunNowResult, type ScreenAgent } from '@roofline/shared';
import { AppError } from '../errors.ts';
import type { JobQueue } from '../jobs/queue.ts';

/**
 * Per-agent "start now" handlers. storm_scout stays unregistered until S1's storm-match job exists on this branch.
 * The G1 agents send their daily job for this company; each job still plans at most once a day.
 */
export const RUN_NOW: Partial<Record<ScreenAgent, (tx: Tx, ctx: TenantContext, jobs: JobQueue) => Promise<void>>> = {
  claims: async (_tx, ctx, jobs) => {
    await jobs.send('claims-daily', { companyId: ctx.companyId }, { singletonKey: `run-now:claims:${ctx.companyId}` });
  },
  scheduler: async (_tx, ctx, jobs) => {
    await jobs.send('scheduler-reminders', { companyId: ctx.companyId }, { singletonKey: `run-now:scheduler:${ctx.companyId}` });
  },
  follow_up: async (_tx, ctx, jobs) => {
    await jobs.send('followup-daily', { companyId: ctx.companyId }, { singletonKey: `run-now:follow_up:${ctx.companyId}` });
  },
};

const MINUTE_MS = 60_000;

/** Throws AppError(409, plain sentence) for non-runnable agents; otherwise claims the 5-minute slot and runs the handler. */
export async function runAgentNow(
  tx: Tx,
  ctx: TenantContext,
  agent: ScreenAgent,
  now: Date,
  jobs: JobQueue,
): Promise<RunNowResult> {
  if (agent === 'estimator') throw new AppError(409, 'This agent works when you ask.');
  if (agent === 'front_desk') throw new AppError(409, 'Front Desk answers calls as they come in.');
  const isG1 = (G1_AGENTS as readonly string[]).includes(agent);
  if (!(LAUNCH_AGENTS as readonly string[]).includes(agent) && !G1_AGENTS_SHIPPED) throw new AppError(409, 'This agent is coming soon.');
  if (isG1 && (await isAgentPaused(tx, ctx, agent))) throw new AppError(409, 'Turn this agent on first.');
  const handler = RUN_NOW[agent];
  if (!handler) throw new AppError(409, 'Storm Scout can check for hail once storm alerts are set up.');

  const claim = await claimRunNow(tx, ctx, agent, now);
  if (!claim.claimed) {
    const minutes = Math.max(1, Math.ceil((claim.nextAllowedAt.getTime() - now.getTime()) / MINUTE_MS));
    throw new AppError(409, `You just ran this. You can run it again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`);
  }
  await handler(tx, ctx, jobs);
  return { started: true, nextAllowedAt: claim.nextAllowedAt.toISOString() };
}
