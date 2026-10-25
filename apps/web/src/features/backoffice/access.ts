import type { Role } from '@roofline/shared';
import type { Account } from '../../api/types.ts';

/** Roles that may open the back office. Reps quote and look; the office and the owner change things. */
const ROLES_IN: readonly Role[] = ['owner', 'office', 'rep'];

/**
 * Whether the person sees the Back office entry: the company has it on (/me's company.backofficeEnabled, where the API
 * puts it) and the role may use it.
 */
export function canOpenBackoffice(account: Pick<Account, 'role' | 'company'> | undefined): boolean {
  return account?.company.backofficeEnabled === true && ROLES_IN.includes(account.role);
}

/** Whether the person may change the price book, move orders and edit the messages. */
export function canEditBackoffice(role: Role | undefined): boolean {
  return role === 'owner' || role === 'office';
}
