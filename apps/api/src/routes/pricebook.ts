import { Router } from 'express';
import { audit, getPricebook, savePricebook, withTenant } from '@roofline/db';
import { type Pricebook, pricebookSchema, type QuoteDefaults, scopeSchema } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { assertKnownFields } from '../validate.ts';

const AMOUNT_MESSAGE = 'Enter an amount from 0 to 100,000.';

/** The keys of a pricebook, in the shared schema's order. Anything else in `prices` is refused by name. */
const PRICE_KEYS = Object.keys(pricebookSchema.shape) as (keyof Pricebook)[];

/** The quote defaults a company may set. Their limits are the scope's own, from the shared schema. */
const DefaultsSchema = scopeSchema.pick({ wastePercent: true, markupPercent: true, taxPercent: true, material: true });
const DEFAULT_KEYS = Object.keys(DefaultsSchema.shape) as (keyof QuoteDefaults)[];

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `prices` must be a pricebook: every price present, each within the shared schema's limits, and
 * no keys the pricebook does not have. Each refusal names the field (`prices.permit`).
 */
function checkPrices(raw: unknown): Pricebook {
  if (!isPlainObject(raw)) throw new AppError(400, MESSAGES.checkField, 'prices');
  const unknown = Object.keys(raw).find((key) => !(PRICE_KEYS as string[]).includes(key));
  if (unknown !== undefined) throw new AppError(400, MESSAGES.checkField, `prices.${unknown}`);
  const prices: Record<string, number> = {};
  for (const key of PRICE_KEYS) {
    const checked = pricebookSchema.shape[key].safeParse(raw[key]);
    if (!checked.success) throw new AppError(400, AMOUNT_MESSAGE, `prices.${key}`);
    prices[key] = checked.data;
  }
  return prices as Pricebook;
}

/** `defaults` must hold exactly the four quote defaults, each within the scope's limits. */
function checkDefaults(raw: unknown): QuoteDefaults {
  if (!isPlainObject(raw)) throw new AppError(400, MESSAGES.checkField, 'defaults');
  const unknown = Object.keys(raw).find((key) => !(DEFAULT_KEYS as string[]).includes(key));
  if (unknown !== undefined) throw new AppError(400, MESSAGES.checkField, `defaults.${unknown}`);
  const defaults: Record<string, unknown> = {};
  for (const key of DEFAULT_KEYS) {
    const checked = DefaultsSchema.shape[key].safeParse(raw[key]);
    if (!checked.success) throw new AppError(400, MESSAGES.checkField, `defaults.${key}`);
    defaults[key] = checked.data;
  }
  return defaults as QuoteDefaults;
}

/**
 * `/api/pricebook`: the company's price list and quote defaults.
 * - GET is for owner and office (`view_money_totals`); a rep gets the standard 403.
 * - PUT replaces the whole pricebook and is for the owner (`company_admin`). Each save is audited
 *   with the values before and after.
 */
export function pricebookRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/', requireCapability('view_money_totals'), async (req, res) => {
    const { ctx } = req;
    const view = await withTenant(pools, ctx, (tx) => getPricebook(tx, ctx));
    res.json(view);
  });

  router.put('/', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const body = assertKnownFields(req.body, ['prices', 'defaults']);
    const prices = checkPrices(body.prices);
    const defaults = checkDefaults(body.defaults);
    const now = clock.now();

    const saved = await withTenant(pools, ctx, async (tx) => {
      const previous = await getPricebook(tx, ctx);
      const view = await savePricebook(tx, ctx, { prices, defaults }, now);
      await audit(tx, ctx, {
        action: 'pricebook.updated',
        targetType: 'pricebook',
        targetId: ctx.companyId,
        before: { prices: previous.prices, defaults: previous.defaults },
        after: { prices, defaults },
        ip: req.ip ?? null,
        at: now,
      });
      return view;
    });
    res.json(saved);
  });

  return router;
}
