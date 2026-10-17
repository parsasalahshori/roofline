import type { ConsentStatus } from '@roofline/shared';
import { Tag, type IconName, type TagTone } from '@roofline/ui';
import { customers } from '../../copy/customers.ts';

/**
 * How each texting status looks as a tag: a colour and a glyph beside its words, never a colour alone. "OK to text" is
 * green with its check; "Asked not to be texted" is a hold, so it is red with its warning; the other two are plain, each
 * with its own glyph (a dash for none, a message for texts about their own jobs only).
 */
const LOOKS: Record<ConsentStatus, { tone: TagTone; icon: IconName }> = {
  none: { tone: 'neutral', icon: 'minus' },
  express: { tone: 'neutral', icon: 'msg' },
  attested: { tone: 'ok', icon: 'check' },
  written: { tone: 'ok', icon: 'check' },
  revoked: { tone: 'bad', icon: 'alert' },
};

/** The texting status of a customer as a tag. The words carry the meaning; the colour and the glyph only help. */
export function ConsentChip({ status }: { status: ConsentStatus }) {
  const { tone, icon } = LOOKS[status];
  return (
    <Tag tone={tone} icon={icon}>
      {customers.consent[status]}
    </Tag>
  );
}
