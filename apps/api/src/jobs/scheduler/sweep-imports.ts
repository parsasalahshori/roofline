import { staleImportIds, withTenant } from '@roofline/db';
import { allCompanyIds } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { systemContext } from '../../permissions.ts';
import { reportJobError } from './report.ts';

/** A queued import this old was never handed to the queue, or its job was lost. */
export const IMPORT_QUEUED_TOO_LONG_MS = 2 * 60 * 1000;
/** A processing import with no progress for this long is stranded; longer than the pg-boss job expiry. */
export const IMPORT_PROCESSING_TOO_LONG_MS = 30 * 60 * 1000;

/**
 * Re-sends the `import-customers` job for imports that look stranded. A queued import is re-sent
 * after 2 minutes, because the send after the commit failed or the job was lost. A processing
 * import is re-sent only after 30 minutes, longer than the pg-boss job expiry, because the queue
 * policy is stately and an early re-send could start a second run while the first is still active.
 * A re-send is safe: the singletonKey keeps one waiting job per import, and `claimImport` lets
 * only one run take it. Each company is read in its own tenant transaction (app_system may not
 * read `imports`), and one failure never stops the others.
 */
export async function sweepImports(deps: AppDeps, now: Date): Promise<{ resent: number }> {
  let resent = 0;
  for (const companyId of await allCompanyIds(deps.pools.system)) {
    const ctx = systemContext(companyId);
    let ids: string[];
    try {
      ids = await withTenant(deps.pools, ctx, (tx) =>
        staleImportIds(
          tx,
          ctx,
          new Date(now.getTime() - IMPORT_QUEUED_TOO_LONG_MS),
          new Date(now.getTime() - IMPORT_PROCESSING_TOO_LONG_MS),
        ),
      );
    } catch (err) {
      reportJobError(deps, err, `sweep-imports: company ${companyId}`);
      continue;
    }
    for (const id of ids) {
      try {
        await deps.jobs.send('import-customers', { companyId, importId: id }, { singletonKey: id });
        resent += 1;
      } catch (err) {
        reportJobError(deps, err, `sweep-imports: import ${id}`);
      }
    }
  }
  return { resent };
}
