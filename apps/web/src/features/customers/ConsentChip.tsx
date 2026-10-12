import type { ConsentStatus } from '@roofline/shared';
import { Pill } from '@roofline/ui';
import { customers } from '../../copy/customers.ts';

/** The texting status of a customer as a chip: "OK to text" is the accent one. */
export function ConsentChip({ status }: { status: ConsentStatus }) {
  const ok = status === 'attested' || status === 'written';
  return <Pill tone={ok ? 'accent' : 'neutral'}>{customers.consent[status]}</Pill>;
}
