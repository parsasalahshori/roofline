import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { companies, companySettings, todayView, type TenantContext, type Tx, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';

/** Used only when the company has no row to read (a company is always created with one, so this is a guard). */
const DEFAULT_TIME_ZONE = 'America/Chicago';
const DEFAULT_STUCK_AFTER_DAYS = 14;

/** The company's zone and its stuck threshold: "today" and "stuck" are counted in the company's zone (spec 5). */
async function companyFacts(tx: Tx, ctx: TenantContext): Promise<{ timeZone: string; stuckAfterDays: number }> {
  const [row] = await tx
    .select({ timezone: companies.timezone, stuckAfterDays: companySettings.stuckAfterDays })
    .from(companies)
    .leftJoin(companySettings, eq(companySettings.companyId, companies.id))
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return {
    timeZone: row?.timezone ?? DEFAULT_TIME_ZONE,
    stuckAfterDays: row?.stuckAfterDays ?? DEFAULT_STUCK_AFTER_DAYS,
  };
}

/**
 * `GET /api/today`: the caller's appointments today (company zone, not canceled) and their follow-ups
 * due today or earlier. Every member may read it; the repository applies what each member may see.
 */
export function todayRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const now = clock.now();
    const view = await withTenant(pools, ctx, async (tx) => {
      const facts = await companyFacts(tx, ctx);
      return todayView(tx, ctx, now, facts.timeZone, facts.stuckAfterDays);
    });
    res.json(view);
  });

  return router;
}
