import { Router } from 'express';
import { audit, getEstimatorSettings, saveEstimatorSettings, withTenant } from '@roofline/db';
import type { EstimatorSettingsPatch } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { assertKnownFields } from '../validate.ts';

const KEYS = [
  'defaultPitchX12',
  'overhangFt',
  'proposalValidDays',
  'aerialMeasure',
  'estimateChangeClause',
  'financingAprBps',
  'financingTermMonths',
] as const;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Each key's rule: true when the value is allowed. */
const RULES: Record<(typeof KEYS)[number], (v: unknown) => boolean> = {
  defaultPitchX12: (v) => isNumber(v) && v >= 0 && v <= 24,
  overhangFt: (v) => isNumber(v) && v >= 0 && v <= 3 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-9,
  proposalValidDays: (v) => isInt(v, 1, 180),
  aerialMeasure: (v) => typeof v === 'boolean',
  estimateChangeClause: (v) => typeof v === 'boolean',
  financingAprBps: (v) => v === null || isInt(v, 0, 5000),
  financingTermMonths: (v) => v === null || isInt(v, 1, 360),
};

/**
 * `/api/estimator/settings`: pitch, overhang, validity, aerial, the estimate clause and financing.
 * GET is for owner and office (`view_money_totals`; Settings -> Prices shows office a read-only copy);
 * PUT is for the owner (`company_admin`); each save is audited with the values before and after.
 */
export function estimatorSettingsRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  // Only a provider with credentials counts as configured.
  const aerialConfigured = deps.aerial.configured;
  const router = Router();

  router.get('/', requireCapability('view_money_totals'), async (req, res) => {
    const { ctx } = req;
    res.json(await withTenant(pools, ctx, (tx) => getEstimatorSettings(tx, ctx, aerialConfigured)));
  });

  router.put('/', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const body = assertKnownFields(req.body, [...KEYS]);
    const patch: Record<string, unknown> = {};
    for (const key of KEYS) {
      if (body[key] === undefined) continue;
      if (!RULES[key](body[key])) throw new AppError(400, MESSAGES.checkField, key);
      patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) throw new AppError(400, MESSAGES.nothingToChange);
    if (patch.aerialMeasure === true && !aerialConfigured) throw new AppError(400, MESSAGES.checkField, 'aerialMeasure');
    const typed = patch as EstimatorSettingsPatch;
    const now = clock.now();

    const saved = await withTenant(pools, ctx, async (tx) => {
      const before = await getEstimatorSettings(tx, ctx, aerialConfigured);
      const apr = typed.financingAprBps !== undefined ? typed.financingAprBps : before.financingAprBps;
      const term = typed.financingTermMonths !== undefined ? typed.financingTermMonths : before.financingTermMonths;
      if ((apr === null) !== (term === null)) throw new AppError(400, MESSAGES.checkField, 'financingTermMonths');
      const after = await saveEstimatorSettings(tx, ctx, typed, aerialConfigured, now);
      await audit(tx, ctx, {
        action: 'estimator_settings.updated',
        targetType: 'estimator_settings',
        targetId: ctx.companyId,
        before,
        after,
        ip: req.ip ?? null,
        at: now,
      });
      return after;
    });
    res.json(saved);
  });

  return router;
}
