import { encrypt } from '@roofline/db';
import { companiesNeedingSubaccount, saveSubaccount } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { reportJobError } from './report.ts';

/**
 * Scheduled job (every minute): gives each company that is ready and has no texting subaccount
 * one, up to 20 per tick. The subaccount's auth token is stored encrypted with `ENCRYPTION_KEY`.
 * A company that fails is logged by its id and error name only (never the provider's message),
 * and the others still go ahead. Does nothing when texting's accounts are not configured.
 */
export async function provisionTexting(deps: AppDeps, now: Date): Promise<void> {
  void now;
  if (!deps.registrar.configured) return;
  const companyIds = await companiesNeedingSubaccount(deps.pools.system, 20);
  for (const companyId of companyIds) {
    try {
      const sub = await deps.registrar.ensureSubaccount(companyId);
      const box = encrypt(sub.authToken, deps.config.ENCRYPTION_KEY);
      await saveSubaccount(deps.pools.system, companyId, sub.accountSid, box);
    } catch (err) {
      reportJobError(deps, errorShell(err), `provision-texting: company ${companyId}`);
    }
  }
}

/** An error carrying only the class name of `err`, so the log never shows a provider's message. */
function errorShell(err: unknown): Error {
  const shell = new Error();
  shell.name = err instanceof Error ? err.name : 'NonErrorThrown';
  return shell;
}
