import type { AppDeps } from '../../app.ts';

/**
 * Moves a company's texting registration along (the `texting-registration` job). Stub: does nothing
 * until the texting registration task fills it in.
 */
export async function advanceRegistration(deps: AppDeps, companyId: string): Promise<void> {
  void deps;
  void companyId;
}
