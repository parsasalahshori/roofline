import type { AppDeps } from '../app.ts';

/** Alerts the owner about a company storm. Stub from S1 Task 7; Task 10 fills it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export async function sendStormAlert(_deps: AppDeps, _companyId: string, _companyStormId: string, _kind: 'now' | 'plan'): Promise<void> {
  throw new Error('not yet');
}
