import { getAdAccount, listPendingAdAccounts, updateAdAccount, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import { systemContext } from '../permissions.ts';
import { evaluateAdAccount } from './ad-accounts.ts';

/**
 * The hourly look at one company's ad accounts that are still waiting (status 'pending'): each gets one
 * live check on its platform, and the result is stored (active, still pending, or error). Provider calls
 * happen outside any transaction. The row is read again before it is written, so an account the owner
 * removed while the platform call was running stays removed. One account failing is logged and does not
 * stop the others. A thrown provider error keeps the account pending with our plain message. A company with nothing pending makes no provider calls.
 *
 * Task 19 adds campaign spend sync beside this, in syncCompanyAds.
 */
export async function recheckPendingAdAccounts(deps: AppDeps, companyId: string, now: Date = deps.clock.now()): Promise<void> {
  const ctx = systemContext(companyId);
  const pending = await withTenant(deps.pools, ctx, (tx) => listPendingAdAccounts(tx, ctx));
  for (const account of pending) {
    try {
      const ev = await evaluateAdAccount(deps, account);
      await withTenant(deps.pools, ctx, async (tx) => {
        const current = await getAdAccount(tx, ctx, account.id);
        if (!current || current.status !== 'pending') return;
        if (ev.fromThrow) {
          await updateAdAccount(tx, ctx, account.id, { status: 'pending', lastErrorPlain: ev.lastErrorPlain, now });
          return;
        }
        await updateAdAccount(tx, ctx, account.id, {
          status: ev.status,
          name: ev.name ?? undefined,
          currency: ev.currency ?? undefined,
          linkedAt: ev.status === 'active' ? now : undefined,
          lastErrorPlain: ev.lastErrorPlain,
          now,
        });
      });
    } catch (err) {
      reportJobError(deps, err, `ad-recheck: company ${companyId} account ${account.id}`);
    }
  }
}
