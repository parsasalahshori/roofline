import { Router } from 'express';
import { conversationTabCounts, frontDeskDayStats, frontDeskStatsCompany, frontDeskWeekStats, withTenant } from '@roofline/db';
import { type FrontDeskDayStats, type FrontDeskWeekStats, localDate, planByKey } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { billingConfig } from '../billing/plans.ts';
import { AppError, MESSAGES } from '../errors.ts';

const BAD_WEEK = 'Use a week start like 2026-10-12.';
const BAD_DAY = 'Use day=today.';
const WEEK_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** The Monday on or before a YYYY-MM-DD date, or null when the text is not a real date. */
function mondayOf(text: string): string | null {
  if (!WEEK_FORMAT.test(text)) return null;
  const d = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) return null;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * `GET /api/front-desk/stats?day=today` (owner, office): today's calls, answer rate and speed, bookings and after-hours calls, with the tab counts.
 * `GET /api/front-desk/stats?week=YYYY-MM-DD` (owner, office): the week's numbers in the company's
 * time zone. A date that is not a Monday snaps back to its Monday; no `week` means this week.
 * Forwarding-test calls are never counted.
 */
export function frontDeskStatsRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    if (ctx.role !== 'owner' && ctx.role !== 'office') throw new AppError(403, MESSAGES.roleCannot);
    const rawDay = req.query.day;
    if (rawDay !== undefined) {
      if (rawDay !== 'today') throw new AppError(400, BAD_DAY, 'day');
      const dayTestCaller = deps.config.TWILIO_TEST_CALLER_NUMBER ?? null;
      const today = await withTenant(deps.pools, ctx, async (tx): Promise<FrontDeskDayStats> => {
        const company = await frontDeskStatsCompany(tx, ctx);
        const day = localDate(deps.clock.now(), company.timeZone);
        const found = await frontDeskDayStats(tx, ctx, day, company.timeZone, dayTestCaller);
        // Owner and office see every conversation, so no rep scope is needed for the tab counts.
        return { ...found, tabCounts: await conversationTabCounts(tx, ctx, { onCall: false }) };
      });
      res.json(today);
      return;
    }
    const raw = req.query.week;
    if (raw !== undefined && typeof raw !== 'string') throw new AppError(400, BAD_WEEK, 'week');
    const asked = raw === undefined ? null : mondayOf(raw);
    if (raw !== undefined && asked === null) throw new AppError(400, BAD_WEEK, 'week');

    const testCaller = deps.config.TWILIO_TEST_CALLER_NUMBER ?? null;
    const stats = await withTenant(deps.pools, ctx, async (tx): Promise<FrontDeskWeekStats> => {
      const company = await frontDeskStatsCompany(tx, ctx);
      const weekStart = asked ?? mondayOf(localDate(deps.clock.now(), company.timeZone));
      if (weekStart === null) throw new Error('The current week could not be worked out.');
      const found = await frontDeskWeekStats(tx, ctx, weekStart, company.timeZone, testCaller);
      const plan = company.planKey ? planByKey(billingConfig(deps), company.planKey) : null;
      return { ...found, aiMinutesIncluded: plan?.included.ai_call_minutes ?? null };
    });
    res.json(stats);
  });

  return router;
}
