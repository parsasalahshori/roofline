import type { ConsentStatus } from '@roofline/shared';
import { Tag } from '@roofline/ui';
import { customers } from '../../copy/customers.ts';

/**
 * The texting status of a customer as a tag: "OK to text" is green with its check; "Asked not to be texted" is a hold, so
 * it is red with its warning; the rest are plain. The words carry the meaning, the colour only helps.
 */
export function ConsentChip({ status }: { status: ConsentStatus }) {
  const ok = status === 'attested' || status === 'written';
  const revoked = status === 'revoked';
  return (
    <Tag tone={ok ? 'ok' : revoked ? 'bad' : 'neutral'} icon={ok ? 'check' : revoked ? 'alert' : undefined}>
      {customers.consent[status]}
    </Tag>
  );
}
