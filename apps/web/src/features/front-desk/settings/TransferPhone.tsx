import { EmptyState } from '@roofline/ui';
import { frontDesk } from '../../../copy/front-desk.ts';

/** Where a person sets the phone that calls transfer to (a placeholder for now). */
export function TransferPhone() {
  return <EmptyState title={frontDesk.transferPhone.empty} />;
}
