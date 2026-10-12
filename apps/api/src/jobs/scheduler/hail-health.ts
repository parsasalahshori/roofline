import { newestProcessedRunAt } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { reportJobError } from './report.ts';

const MINUTE_MS = 60_000;
const TICK_MINUTES = 15;

/** Minutes without a new processed grid before hail data counts as stale: 3 hours in storm season (UTC April to September), 12 hours otherwise. */
export function staleThresholdMinutes(now: Date): number {
  const month = now.getUTCMonth();
  return month >= 3 && month <= 8 ? 180 : 720;
}

/**
 * Every 15 minutes: emails ops when no new processed hail grid arrived within `staleThresholdMinutes`.
 * Freshness comes only from hail_runs rows with status 'processed' (failed rows carry valid_at = now);
 * the hail worker itself already emails ops after 3 consecutive failed ticks, so this alert is for stale
 * data. The schedule keeps no state, so it emails only on the first tick after crossing the threshold
 * (age over the threshold and at most one tick beyond it). No processed run at all (fresh install) sends
 * nothing. Without OPS_ALERT_EMAIL the problem is reported to the log instead. A mailer failure is
 * reported, never thrown. The stale banner (routes/storms.ts, HAIL_STALE_MINUTES) is separate.
 */
export async function hailHealth(deps: AppDeps, now: Date): Promise<void> {
  const newest = await newestProcessedRunAt(deps.pools.system);
  if (newest === null) return;
  const age = now.getTime() - newest.getTime();
  const threshold = staleThresholdMinutes(now) * MINUTE_MS;
  if (age <= threshold || age > threshold + TICK_MINUTES * MINUTE_MS) return;

  const to = deps.config.OPS_ALERT_EMAIL;
  if (!to) {
    reportJobError(deps, new Error('Hail data is stale and OPS_ALERT_EMAIL is not set.'), 'hail-health');
    return;
  }
  try {
    await deps.mailer.send({ to, subject: 'Hail data is behind', text: `The newest processed hail grid is from ${newest.toISOString()}.` });
  } catch (err) {
    reportJobError(deps, err, 'hail-health');
  }
}
