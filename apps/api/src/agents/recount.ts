import {
  audit,
  insertTimeRecount,
  listRecountSteps,
  loadBaselineOverrides,
  refreshTaskMinutes,
  rewriteStepSnapshot,
  tryLockRecount,
  withTenant,
  type Pools,
  type TenantContext,
  type Tx,
} from '@roofline/db';
import { AppError } from '../errors.ts';
import { isStepType, stepMinutes, stepTypes, type RecountResult, type StepResult } from '@roofline/shared';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;
const BATCH = 1000;

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Recounts the last 90 days ending at `now`: every done step with a known type is recomputed from its
 * payload and result with the current baselines (never units x minutes_per_unit). Batches of 1,000
 * steps, one transaction each. A dry run reads only; a real run also records the recount and an audit row.
 * `ip` goes to the audit row.
 */
export async function recountMinutes(
  pools: Pools,
  ctx: TenantContext,
  opts: { dryRun: boolean; now: Date; ip: string | null },
): Promise<RecountResult> {
  const { dryRun, now, ip } = opts;
  const from = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const to = now;
  let before = 0;
  let after = 0;
  let steps = 0;
  let afterId: string | null = null;
  let started = false;

  const lock = async (tx: Tx): Promise<void> => {
    if (!(await tryLockRecount(tx, ctx))) throw new AppError(409, 'A recount is already running.');
  };

  try {
    // One read of the company's baselines, so every batch counts with the same numbers.
    const overrides = await withTenant(pools, ctx, (tx) => loadBaselineOverrides(tx, ctx));
    let first = true;
    for (;;) {
      const isFirst = first;
      first = false;
      // Counted in locals and added only after the transaction commits: a rolled-back batch adds nothing.
      let batchBefore = 0;
      let batchAfter = 0;
      let batchSteps = 0;
      const lastId: string | null = await withTenant(pools, ctx, async (tx) => {
        batchBefore = 0;
        batchAfter = 0;
        batchSteps = 0;
        await lock(tx);
        if (isFirst && !dryRun) {
          await audit(tx, ctx, {
            action: 'agents.recount.started',
            targetType: 'time_recount',
            targetId: ctx.companyId,
            after: { from: from.toISOString(), to: to.toISOString(), by: ctx.userId, baselines: overrides },
            ip,
            at: now,
          });
        }
        const batch = await listRecountSteps(tx, ctx, { from, to, afterId, limit: BATCH });
        if (batch.length === 0) return null;
        const touched = new Set<string>();
        for (const step of batch) {
          if (!isStepType(step.type)) continue;
          const m = stepMinutes(stepTypes[step.type] as never, step.payload as never, (step.result ?? {}) as StepResult, overrides);
          batchBefore += round2(step.minutesSaved ?? 0);
          batchAfter += round2(m.minutes);
          batchSteps += 1;
          if (!dryRun) {
            await rewriteStepSnapshot(tx, ctx, step.id, {
              units: m.units,
              minutesPerUnit: m.minutesPerUnit,
              minutesSaved: m.minutes,
            });
            touched.add(step.taskId);
          }
        }
        if (!dryRun && touched.size > 0) await refreshTaskMinutes(tx, ctx, [...touched]);
        return batch[batch.length - 1]!.id;
      });
      if (isFirst && !dryRun) started = true;
      before += batchBefore;
      after += batchAfter;
      steps += batchSteps;
      if (lastId === null) break;
      afterId = lastId;
    }
  } catch (error) {
    if (!dryRun && started) {
      try {
        await withTenant(pools, ctx, (tx) =>
          audit(tx, ctx, {
            action: 'agents.recount.partial',
            targetType: 'time_recount',
            targetId: ctx.companyId,
            before: { minutes: round2(before) },
            after: { minutes: round2(after), steps },
            ip,
            at: now,
          }),
        );
      } catch {
        // The original error is the one to report.
      }
    }
    throw error;
  }

  const beforeMinutes = round2(before);
  const afterMinutes = round2(after);

  if (!dryRun) {
    await withTenant(pools, ctx, async (tx) => {
      await lock(tx);
      const id = await insertTimeRecount(tx, ctx, { from, to, beforeMinutes, afterMinutes, at: now });
      await audit(tx, ctx, {
        action: 'agents.recount',
        targetType: 'time_recount',
        targetId: id,
        before: { minutes: beforeMinutes },
        after: { minutes: afterMinutes, steps },
        ip,
        at: now,
      });
    });
  }

  return { dryRun, from: from.toISOString(), to: to.toISOString(), beforeMinutes, afterMinutes, steps };
}
