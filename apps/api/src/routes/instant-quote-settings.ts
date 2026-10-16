import { Router } from 'express';
import { z } from 'zod';
import { getQuoteSettings, QuoteSlugTakenError, saveQuoteSettings, withTenant } from '@roofline/db';
import {
  type InstantQuoteSettings,
  QUOTE_COLOR_RE,
  QUOTE_LIMITS,
  QUOTE_ORIGIN_RE,
  QUOTE_PRODUCTS,
  QUOTE_SLUG_RE,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { parse } from '../validate.ts';

/*
 * `/api/instant-quote/settings`: the owner's instant quote page (Settings -> Instant quote). GET for owner and
 * office (`view_money_totals`), PUT for the owner (`company_admin`); every save is audited before and after.
 * The answer also carries `pageUrl`, the public page's address, for the embed snippet.
 */

const SLUG_MESSAGE = 'Use 3 to 40 lowercase letters, numbers and dashes.';
const ORIGIN_MESSAGE = 'Enter each site as https://example.com, without a path.';

const Body = z
  .object({
    enabled: z.boolean(),
    slug: z.string({ error: SLUG_MESSAGE }).trim().toLowerCase().regex(QUOTE_SLUG_RE, SLUG_MESSAGE).nullable(),
    products: z.array(z.enum(QUOTE_PRODUCTS)).min(1, 'Pick at least one service.').max(QUOTE_PRODUCTS.length),
    rangePct: z.number().int().min(QUOTE_LIMITS.rangePctMin, 'Use 5 to 40 percent.').max(QUOTE_LIMITS.rangePctMax, 'Use 5 to 40 percent.'),
    dailyCap: z.number().int().min(0, 'Use 0 to 1,000.').max(QUOTE_LIMITS.dailyCapMax, 'Use 0 to 1,000.'),
    embedOrigins: z
      .array(
        z
          .string({ error: ORIGIN_MESSAGE })
          .trim()
          .toLowerCase()
          .transform((v) => v.replace(/\/+$/, ''))
          .pipe(z.string().max(QUOTE_LIMITS.originMax, ORIGIN_MESSAGE).regex(QUOTE_ORIGIN_RE, ORIGIN_MESSAGE)),
      )
      .max(QUOTE_LIMITS.maxOrigins, 'Add up to 10 sites.'),
    booking: z.boolean(),
    accentColor: z.string().trim().regex(QUOTE_COLOR_RE, 'Use a colour like #1f6feb.').nullable(),
  })
  .strict()
  .refine((b) => !b.enabled || b.slug !== null, { message: 'Pick the page address first.', path: ['slug'] });

export function instantQuoteSettingsRoutes(deps: AppDeps): Router {
  const { pools, clock, config } = deps;
  const router = Router();
  const pageUrl = (slug: string | null) => (slug === null ? null : `${config.APP_ORIGIN}/q/${slug}`);

  router.get('/', requireCapability('view_money_totals'), async (req, res) => {
    const { ctx } = req;
    const settings = await withTenant(pools, ctx, (tx) => getQuoteSettings(tx, ctx));
    res.json({ ...settings, pageUrl: pageUrl(settings.slug) });
  });

  router.put('/', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const body = parse(Body, req.body) as InstantQuoteSettings;
    const next: InstantQuoteSettings = { ...body, embedOrigins: [...new Set(body.embedOrigins)] };
    try {
      const saved = await withTenant(pools, ctx, (tx) => saveQuoteSettings(tx, ctx, next, clock.now()));
      res.json({ ...saved, pageUrl: pageUrl(saved.slug) });
    } catch (err) {
      if (err instanceof QuoteSlugTakenError) throw new AppError(409, err.message, 'slug');
      throw err;
    }
  });

  return router;
}
