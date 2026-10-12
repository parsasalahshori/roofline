import type { TenantContext } from '@roofline/db';
import type { AppDeps } from '../app.ts';

// Stub from E1 Task 5; the real body arrives in a later task.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export async function sendProposal(_deps: AppDeps, _ctx: TenantContext, _input: unknown): Promise<never> {
  throw new Error('not yet');
}
