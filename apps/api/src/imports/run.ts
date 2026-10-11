import type { AppDeps } from '../app.ts';
import type { JobMeta } from '../jobs/queue.ts';

/**
 * Runs one customer import (the `import-customers` job). Stub: does nothing until the import
 * task fills it in. Resolves when the import is finished, or when this attempt is saved for a retry.
 */
export async function runImport(deps: AppDeps, companyId: string, importId: string, meta: JobMeta): Promise<void> {
  void deps;
  void companyId;
  void importId;
  void meta;
}
