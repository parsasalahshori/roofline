import { registrationsToCheck } from '@roofline/db/system';
import { advanceRegistration } from '../../account/texting/advance.ts';
import type { AppDeps } from '../../app.ts';
import { reportJobError } from './report.ts';

/**
 * Scheduled job: polls texting registration status (`0 * * * *`, with the clock's time). Each
 * registration due a check (see `registrationsToCheck`) is advanced in turn; one that fails is
 * logged and the rest still run. Does nothing when no texting registrar is configured.
 */
export async function pollTexting(deps: AppDeps, now: Date): Promise<void> {
  if (!deps.registrar.configured) return;
  const ids = await registrationsToCheck(deps.pools.system, now);
  for (const id of ids) {
    try {
      await advanceRegistration(deps, id);
    } catch (err) {
      reportJobError(deps, err, 'poll-texting');
    }
  }
}
