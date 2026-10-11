import { eq, sql } from 'drizzle-orm';
import { localDate } from '@roofline/shared';
import type { Db } from '../pools.ts';
import { companies } from '../schema/index.ts';

/*
 * What the signed-in member has seen, kept on their membership. On the app_system pool because
 * app_tenant has no grant on memberships. Only apps/api/src/auth/me.ts calls it. As elsewhere in
 * this folder, nothing here reads a clock: the caller passes `now`.
 */

/**
 * Marks the Today window as shown for this member on the company's current calendar day, and says
 * whether it changed anything: true the first time on a given day, false for every later call that
 * day. The day is `now` in the COMPANY's time zone (Chicago's day for a Chicago roofer, wherever
 * the browser is).
 *
 * The zone is read first, in the same transaction, and then ONE statement does the compare and the
 * write. Two tabs asking at once cannot both win: the second update waits for the first row lock,
 * re-reads the row, finds today already there, and changes nothing. A disabled member, or one who
 * is not in the company, changes nothing either (false).
 */
export async function markTodayShown(system: Db, companyId: string, userId: string, now: Date): Promise<boolean> {
  return system.transaction(async (tx) => {
    const [company] = await tx
      .select({ timezone: companies.timezone })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!company) return false;
    const today = localDate(now, company.timezone);
    const result = await tx.execute(sql`
      update memberships m
      set last_today_shown_on = ${today}::date, updated_at = now()
      from companies c
      where c.id = m.company_id
        and m.company_id = ${companyId}
        and m.user_id = ${userId}
        and m.status = 'active'
        and m.last_today_shown_on is distinct from ${today}::date
      returning m.id
    `);
    return result.rows.length > 0;
  });
}
