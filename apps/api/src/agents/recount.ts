import {
  audit,
  insertTimeRecount,
  listRecountSteps,
  loadBaselineOverrides,
  refreshTaskMinutes,
  rewriteStepSnapshot,
  withTenant,
  type Pools,
  type TenantContext,
} from '@roofline/db';
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

  for (;;) {
    const lastId: string | null = await withTenant(pools, ctx, async (tx) => {
      const batch = await listRecountSteps(tx, ctx, { from, to, afterId, limit: BATCH });
      if (batch.length === 0) return null;
      const overrides = await loadBaselineOverrides(tx, ctx);
      const touched = new Set<string>();
      for (const step of batch) {
        if (!isStepType(step.type)) continue;
        const m = stepMinutes(stepTypes[step.type] as never, step.payload as never, (step.result ?? {}) as StepResult, overrides);
        before += round2(step.minutesSaved ?? 0);
        after += round2(m.minutes);
        steps += 1;
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
    if (lastId === null) break;
    afterId = lastId;
  }

  const beforeMinutes = round2(before);
  const afterMinutes = round2(after);

  if (!dryRun) {
    await withTenant(pools, ctx, async (tx) => {
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
