import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { audit, companySettings, loadBaselineOverrides, setBaselineOverrides, setPaused, withTenant } from '@roofline/db';
import type { Tx, TenantContext } from '@roofline/db';
import {
  isEditableBaselineKey,
  isScreenAgent,
  LAUNCH_AGENTS,
  TIME_BASELINES,
  VISIBLE_BASELINE_KEYS,
  type BaselineKey,
  type TimeBaselineRow,
  type TimeBaselines,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { recountMinutes } from '../agents/recount.ts';
import { runAgentNow } from '../agents/run-now.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can, requireCapability } from '../permissions.ts';

const MINUTES_MESSAGE = 'Please enter minutes from 0 to 600, in steps of half a minute.';
const CHOOSE_MESSAGE = 'Please choose yes or no.';
const DEFAULT_HOURLY_RATE_CENTS = 2800;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The visible baselines with this company's numbers, whether the reader may edit, and the hourly rate. */
async function buildBaselines(tx: Tx, ctx: TenantContext): Promise<TimeBaselines> {
  const overrides = await loadBaselineOverrides(tx, ctx);
  const rows: TimeBaselineRow[] = VISIBLE_BASELINE_KEYS.map((key) => {
    const def: { minutes: number; capMinutes?: number; unit: string; basis: string; perCallLength?: boolean } = TIME_BASELINES[key];
    return {
      key,
      unit: def.unit,
      basis: def.basis,
      defaultMinutes: def.minutes,
      minutes: overrides[key] ?? def.minutes,
      capMinutes: def.capMinutes ?? null,
      perCallLength: def.perCallLength === true,
    };
  });
  const [settings] = await tx
    .select({ hourlyRateCents: companySettings.hourlyRateCents })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId));
  return { rows, canEdit: can(ctx, 'company_admin'), hourlyRateCents: settings?.hourlyRateCents ?? DEFAULT_HOURLY_RATE_CENTS };
}

/** A1 Task 7: /api/agents/time-baselines, /time-baselines/recount, /:agent/paused, /:agent/run. */
export function agentSettingsRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/time-baselines', requireCapability('view_money_totals'), async (req, res) => {
    const { ctx } = req;
    res.json(await withTenant(pools, ctx, (tx) => buildBaselines(tx, ctx)));
  });

  router.put('/time-baselines', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const body: unknown = req.body;
    if (!isPlainObject(body) || !isPlainObject(body.minutes)) throw new AppError(400, MESSAGES.checkField, 'minutes');
    const changes: Partial<Record<BaselineKey, number | null>> = {};
    for (const [key, value] of Object.entries(body.minutes)) {
      if (!isEditableBaselineKey(key)) throw new AppError(400, `We don't have a time setting called "${key}".`, key);
      if (value === null) {
        changes[key] = null;
      } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 600 && Number.isInteger(value * 2)) {
        changes[key] = value;
      } else {
        throw new AppError(400, MINUTES_MESSAGE, key);
      }
    }
    const keys = Object.keys(changes) as BaselineKey[];
    if (keys.length === 0) throw new AppError(400, MESSAGES.nothingToChange);
    const now = clock.now();
    const result = await withTenant(pools, ctx, async (tx) => {
      const before = await loadBaselineOverrides(tx, ctx);
      await setBaselineOverrides(tx, ctx, changes, now);
      const after = await loadBaselineOverrides(tx, ctx);
      const pickKeys = (m: Partial<Record<BaselineKey, number>>) =>
        Object.fromEntries(keys.map((k) => [k, m[k] ?? TIME_BASELINES[k].minutes]));
      await audit(tx, ctx, {
        action: 'agents.baselines.update',
        targetType: 'time_baselines',
        targetId: ctx.companyId,
        before: pickKeys(before),
        after: pickKeys(after),
        ip: req.ip ?? null,
        at: now,
      });
      return buildBaselines(tx, ctx);
    });
    res.json(result);
  });

  router.post('/time-baselines/recount', requireCapability('company_admin'), async (req, res) => {
    const result = await recountMinutes(pools, req.ctx, {
      dryRun: req.query.dryRun === '1',
      now: clock.now(),
      ip: req.ip ?? null,
    });
    res.json(result);
  });

  router.put('/:agent/paused', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const agent = req.params.agent;
    if (!isScreenAgent(agent)) throw new AppError(404, MESSAGES.notFound);
    if (!(LAUNCH_AGENTS as readonly string[]).includes(agent)) throw new AppError(409, 'This agent is coming soon.');
    const body: unknown = req.body;
    if (!isPlainObject(body) || typeof body.paused !== 'boolean') throw new AppError(400, CHOOSE_MESSAGE, 'paused');
    const paused = body.paused;
    const now = clock.now();
    const row = await withTenant(pools, ctx, async (tx) => {
      const saved = await setPaused(tx, ctx, agent, paused, now);
      await audit(tx, ctx, {
        action: paused ? 'agents.pause' : 'agents.resume',
        targetType: 'agent',
        targetId: ctx.companyId,
        after: { agent, paused },
        ip: req.ip ?? null,
        at: now,
      });
      return saved;
    });
    res.json({ paused: row.pausedAt !== null, pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null });
  });

  router.post('/:agent/run', requireCapability('approve_internal'), async (req, res) => {
    const { ctx } = req;
    const agent = req.params.agent;
    if (!isScreenAgent(agent)) throw new AppError(404, MESSAGES.notFound);
    const now = clock.now();
    const result = await withTenant(pools, ctx, (tx) => runAgentNow(tx, ctx, agent, now));
    res.status(202).json(result);
  });

  return router;
}
