import { getConnection, withTenant } from '@roofline/db';
import { connectionsDueForPull } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { pullConnection } from '../../calendar/pull.ts';
import { systemContext } from '../../permissions.ts';
import { reportJobError } from './report.ts';

/**
 * Scheduled job (every 5 minutes): pulls outside calendar changes for up to 50 connected calendars
 * that are due, oldest first. Each is in its own try/catch: one failure is logged (never tokens or
 * provider text) and the loop goes on to the next connection.
 */
export async function pullCalendars(deps: AppDeps, now: Date): Promise<void> {
  const due = await connectionsDueForPull(deps.pools.system, now, 50);
  for (const { companyId, userId } of due) {
    try {
      const ctx = systemContext(companyId);
      const conn = await withTenant(deps.pools, ctx, (tx) => getConnection(tx, ctx, userId));
      if (!conn || conn.status !== 'connected') continue;
      await pullConnection(deps, ctx, conn);
    } catch (err) {
      reportJobError(deps, err, `calendar-pull: company ${companyId}`);
    }
  }
}
