import { Router } from 'express';
import { audit, expireQuoteEstimates, getWindowCatalog, saveWindowCatalog, withTenant } from '@roofline/db';
import { WindowCatalogSchema } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { assertKnownFields } from '../validate.ts';

/**
 * `/api/window-catalog`: what the company's homeowner pages and app offer for windows: the style choices, the tiers'
 * names and prices, the adders, what every window includes, trust facts, the offer banner and the financing line.
 * - GET is for owner and office (`view_money_totals`).
 * - PUT replaces the whole catalog and is for the owner (`company_admin`); each save is audited and the stored quote
 *   estimates are expired (their window ranges were priced from the old list).
 */
export function windowCatalogRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/', requireCapability('view_money_totals'), async (req, res) => {
    const { ctx } = req;
    res.json({ catalog: await withTenant(pools, ctx, (tx) => getWindowCatalog(tx, ctx)) });
  });

  router.put('/', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const body = assertKnownFields(req.body, ['catalog']);
    const checked = WindowCatalogSchema.safeParse(body.catalog);
    if (!checked.success) {
      const issue = checked.error.issues[0]!;
      const path = issue.path.map(String).join('.');
      throw new AppError(400, issue.code === 'custom' ? issue.message : MESSAGES.checkField, path === '' ? 'catalog' : `catalog.${path}`);
    }
    const now = clock.now();
    const saved = await withTenant(pools, ctx, async (tx) => {
      const before = await getWindowCatalog(tx, ctx);
      const after = await saveWindowCatalog(tx, ctx, checked.data, now);
      await expireQuoteEstimates(tx, ctx, now);
      await audit(tx, ctx, { action: 'window_catalog.updated', targetType: 'window_catalog', targetId: ctx.companyId, before, after, ip: req.ip ?? null, at: now });
      return after;
    });
    res.json({ catalog: saved });
  });

  return router;
}
