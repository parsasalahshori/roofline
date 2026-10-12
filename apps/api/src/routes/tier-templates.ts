import { Router } from 'express';
import { audit, getTierTemplates, saveTierTemplates, withTenant } from '@roofline/db';
import { TIERS, TierTemplateSchema, type TierTemplate } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { assertKnownFields } from '../validate.ts';

const TEMPLATE_KEYS = ['tier', 'name', 'material', 'wastePercent', 'markupPercent', 'addOns', 'highlights', 'enabled'];

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Exactly three templates, one per tier, each valid; a refusal names `templates` or `templates.N.key`. */
function checkTemplates(raw: unknown): TierTemplate[] {
  if (!Array.isArray(raw) || raw.length !== TIERS.length) throw new AppError(400, MESSAGES.checkField, 'templates');
  const parsed = raw.map((item: unknown, index) => {
    if (!isPlainObject(item)) throw new AppError(400, MESSAGES.checkField, `templates.${index}`);
    const unknown = Object.keys(item).find((key) => !TEMPLATE_KEYS.includes(key));
    if (unknown !== undefined) throw new AppError(400, MESSAGES.checkField, `templates.${index}.${unknown}`);
    const checked = TierTemplateSchema.safeParse(item);
    if (!checked.success) {
      const key = checked.error.issues[0]?.path[0];
      throw new AppError(400, MESSAGES.checkField, key === undefined ? `templates.${index}` : `templates.${index}.${String(key)}`);
    }
    return checked.data;
  });
  if (!TIERS.every((tier) => parsed.filter((p) => p.tier === tier).length === 1)) {
    throw new AppError(400, MESSAGES.checkField, 'templates');
  }
  return parsed;
}

/**
 * `/api/tier-templates`: the Good/Better/Best templates a new proposal starts from.
 * - GET is for owner and office (`view_money_totals`).
 * - PUT replaces all three and is for the owner (`company_admin`); each save is audited.
 */
export function tierTemplateRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/', requireCapability('view_money_totals'), async (req, res) => {
    const { ctx } = req;
    const view = await withTenant(pools, ctx, (tx) => getTierTemplates(tx, ctx));
    res.json(view);
  });

  router.put('/', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const body = assertKnownFields(req.body, ['templates']);
    const templates = checkTemplates(body.templates);
    const now = clock.now();

    const saved = await withTenant(pools, ctx, async (tx) => {
      const before = await getTierTemplates(tx, ctx);
      const after = await saveTierTemplates(tx, ctx, templates, now);
      await audit(tx, ctx, {
        action: 'tier_templates.updated',
        targetType: 'tier_templates',
        targetId: ctx.companyId,
        before,
        after: { templates: after },
        ip: req.ip ?? null,
        at: now,
      });
      return after;
    });
    res.json({ templates: saved });
  });

  return router;
}
