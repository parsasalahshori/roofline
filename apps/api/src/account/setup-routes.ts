import { Router, type RequestHandler } from 'express';
import { audit, saveSetupItems, setSetupSkipped, setupFacts, withTenant, type TenantContext } from '@roofline/db';
import { listPendingInvites } from '@roofline/db/system';
import {
  deriveSetup,
  SETUP_ITEM_KEYS,
  SKIPPABLE,
  type SetupItemKey,
  type SetupView,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';

/** Ruling 33: F3 keeps its plain-English messages here, not in errors.ts. */
const CANNOT_SKIP = "This step can't be skipped.";

/**
 * The setup checklist, derived from the company's real records on every read. `GET /api/setup`
 * is open to every member; skipping and unskipping an item needs `company_admin`.
 */
export function setupRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  /**
   * The checklist as it is now. The pending-invite count reads the system pool, so it runs outside
   * the tenant transaction; the facts, the derived view and the saved rows share one.
   */
  async function currentView(ctx: TenantContext, now: Date): Promise<SetupView> {
    const pendingInvites = (await listPendingInvites(pools.system, ctx.companyId, now)).length;
    return withTenant(pools, ctx, async (tx) => {
      const facts = await setupFacts(tx, ctx);
      const view = deriveSetup({ ...facts, pendingInvites });
      await saveSetupItems(tx, ctx, view.items, now);
      return view;
    });
  }

  function skipHandler(skipped: boolean): RequestHandler {
    return async (req, res) => {
      const { ctx } = req;
      const key = req.params.key;
      // An unknown key and a known key that is not skippable are different answers, in that order.
      if (typeof key !== 'string' || !(SETUP_ITEM_KEYS as readonly string[]).includes(key)) {
        throw new AppError(404, MESSAGES.notFound);
      }
      const itemKey = key as SetupItemKey;
      if (!SKIPPABLE.has(itemKey)) throw new AppError(400, CANNOT_SKIP);

      const now = clock.now();
      await withTenant(pools, ctx, async (tx) => {
        await setSetupSkipped(tx, ctx, itemKey, skipped, now);
        // The audit row names the item in `after`; the company is the record it happened to,
        // since a setup item has no id of its own.
        await audit(tx, ctx, {
          action: skipped ? 'setup.skip' : 'setup.unskip',
          targetType: 'company',
          targetId: ctx.companyId,
          after: { key: itemKey },
          ip: req.ip ?? null,
          at: now,
        });
      });
      res.json(await currentView(ctx, clock.now()));
    };
  }

  router.get('/', async (req, res) => {
    res.json(await currentView(req.ctx, clock.now()));
  });

  router.post('/:key/skip', requireCapability('company_admin'), skipHandler(true));
  router.post('/:key/unskip', requireCapability('company_admin'), skipHandler(false));

  return router;
}
