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

const COOLDOWN_MS = 6 * 60 * MINUTE_MS;
const SERVICE_STARTED_AT = new Date();

/** True on the first tick after `over` (ms past the threshold) turns positive, then again every 6 hours. */
function dueNow(over: number): boolean {
  return over > 0 && over % COOLDOWN_MS < TICK_MINUTES * MINUTE_MS;
}

/**
 * Every 15 minutes: emails ops when no new processed hail grid arrived within `staleThresholdMinutes`.
 * Freshness comes only from hail_runs rows with status 'processed' (failed rows carry valid_at = now);
 * the hail worker itself already emails ops after 3 consecutive failed ticks, so this alert is for stale
 * data. The schedule keeps no state: while data stays stale it emails on the first tick after crossing the
 * threshold and again every 6 hours (the time past the threshold falls in a 15 minute bucket of each
 * 6 hour cycle). With no processed run at all, the same rule runs on the time since the service started
 * (`startedAt`), so a fresh install that never gets data is reported too. Without OPS_ALERT_EMAIL the
 * problem is reported to the log instead. A mailer failure is reported, never thrown. The stale banner
 * (routes/storms.ts, HAIL_STALE_MINUTES) is separate.
 */
export async function hailHealth(deps: AppDeps, now: Date, startedAt: Date = SERVICE_STARTED_AT): Promise<void> {
  const newest = await newestProcessedRunAt(deps.pools.system);
  const threshold = staleThresholdMinutes(now) * MINUTE_MS;
  const since = newest ?? startedAt;
  if (!dueNow(now.getTime() - since.getTime() - threshold)) return;

  const to = deps.config.OPS_ALERT_EMAIL;
  if (!to) {
    reportJobError(deps, new Error('Hail data is stale and OPS_ALERT_EMAIL is not set.'), 'hail-health');
    return;
  }
  const message =
    newest === null
      ? { subject: 'Hail data has never arrived', text: `No processed hail grid has arrived since the service started at ${startedAt.toISOString()}.` }
      : { subject: 'Hail data is behind', text: `The newest processed hail grid is from ${newest.toISOString()}.` };
  try {
    await deps.mailer.send({ to, ...message });
  } catch (err) {
    reportJobError(deps, err, 'hail-health');
  }
}
