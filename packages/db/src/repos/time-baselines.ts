import { and, asc, eq, gt, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { type BaselineKey, isEditableBaselineKey } from '@roofline/shared';
import { agentTasks, agentTaskSteps, timeBaselines, timeRecounts } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { sumStepMinutesSaved } from './tasks.ts';

/**
 * The company's own minutes-per-unit for the baseline keys an owner can edit. A key with no row
 * is missing from the map (the default applies). Unknown and hidden keys are ignored.
 */
export async function loadBaselineOverrides(tx: Tx, ctx: TenantContext): Promise<Partial<Record<BaselineKey, number>>> {
  const rows = await tx
    .select({ key: timeBaselines.key, minutesPerUnit: timeBaselines.minutesPerUnit })
    .from(timeBaselines)
    .where(eq(timeBaselines.companyId, ctx.companyId));
  const out: Partial<Record<BaselineKey, number>> = {};
  for (const row of rows) {
    if (isEditableBaselineKey(row.key)) out[row.key] = row.minutesPerUnit;
  }
  return out;
}

// ---- A1 Task 7 SHELL (Package 1 fills these in; signatures are fixed) ----

/** One done step as the recount sees it. */
export type RecountStep = {
  id: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  /** The stored snapshot (null counts as 0). */
  minutesSaved: number | null;
};

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Upserts a number, deletes the row for null. Keys are already validated. Stamps updatedAt = now. */
export async function setBaselineOverrides(
  tx: Tx,
  ctx: TenantContext,
  changes: Partial<Record<BaselineKey, number | null>>,
  now: Date,
): Promise<void> {
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null) {
      await tx.delete(timeBaselines).where(and(eq(timeBaselines.companyId, ctx.companyId), eq(timeBaselines.key, key)));
    } else {
      await tx
        .insert(timeBaselines)
        .values({ companyId: ctx.companyId, key, minutesPerUnit: value, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [timeBaselines.companyId, timeBaselines.key],
          set: { minutesPerUnit: value, updatedAt: now },
        });
    }
  }
}

/** Done steps with a non-null baseline_key and updated_at in [from, to], id > afterId, ordered by id, at most limit. */
export async function listRecountSteps(
  tx: Tx,
  ctx: TenantContext,
  range: { from: Date; to: Date; afterId: string | null; limit: number },
): Promise<RecountStep[]> {
  const rows = await tx
    .select({
      id: agentTaskSteps.id,
      taskId: agentTaskSteps.taskId,
      type: agentTaskSteps.type,
      payload: agentTaskSteps.payload,
      result: agentTaskSteps.result,
      minutesSaved: agentTaskSteps.minutesSaved,
    })
    .from(agentTaskSteps)
    .where(
      and(
        eq(agentTaskSteps.companyId, ctx.companyId),
        eq(agentTaskSteps.status, 'done'),
        isNotNull(agentTaskSteps.baselineKey),
        gte(agentTaskSteps.updatedAt, range.from),
        lte(agentTaskSteps.updatedAt, range.to),
        range.afterId === null ? undefined : gt(agentTaskSteps.id, range.afterId),
      ),
    )
    .orderBy(asc(agentTaskSteps.id))
    .limit(range.limit);
  return rows.map((r) => ({ ...r, payload: r.payload ?? {}, result: r.result ?? null }));
}

/** Rewrites one step's snapshot columns (units, minutes_per_unit, minutes_saved, all round2). Does NOT change updated_at. */
export async function rewriteStepSnapshot(
  tx: Tx,
  ctx: TenantContext,
  stepId: string,
  snapshot: { units: number; minutesPerUnit: number; minutesSaved: number },
): Promise<void> {
  await tx
    .update(agentTaskSteps)
    .set({
      units: round2(snapshot.units),
      minutesPerUnit: round2(snapshot.minutesPerUnit),
      minutesSaved: round2(snapshot.minutesSaved),
      // $onUpdate would bump updated_at, and the 90-day window keys on it: keep the stored value.
      updatedAt: sql`${agentTaskSteps.updatedAt}`,
    })
    .where(and(eq(agentTaskSteps.companyId, ctx.companyId), eq(agentTaskSteps.id, stepId)));
}

/** Sets agent_tasks.minutes_saved = Math.round(sumStepMinutesSaved) for each task id. Does NOT change updated_at. */
export async function refreshTaskMinutes(tx: Tx, ctx: TenantContext, taskIds: string[]): Promise<void> {
  for (const id of taskIds) {
    const total = Math.round(await sumStepMinutesSaved(tx, ctx, id));
    await tx
      .update(agentTasks)
      .set({ minutesSaved: total, updatedAt: sql`${agentTasks.updatedAt}` })
      .where(and(eq(agentTasks.companyId, ctx.companyId), eq(agentTasks.id, id)));
  }
}

/** Inserts the time_recounts row (by_user_id = ctx.userId, which must be non-null). */
export async function insertTimeRecount(
  tx: Tx,
  ctx: TenantContext,
  row: { from: Date; to: Date; beforeMinutes: number; afterMinutes: number; at: Date },
): Promise<string> {
  if (ctx.userId === null) throw new Error('A recount needs a signed-in person.');
  const [created] = await tx
    .insert(timeRecounts)
    .values({
      companyId: ctx.companyId,
      byUserId: ctx.userId,
      fromAt: row.from,
      toAt: row.to,
      beforeMinutes: row.beforeMinutes,
      afterMinutes: row.afterMinutes,
      at: row.at,
    })
    .returning({ id: timeRecounts.id });
  return created!.id;
}
