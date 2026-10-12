import { EmptyState } from '@roofline/ui';
import { setup } from '../../copy/setup.ts';

/** The Setup settings tab. A placeholder until the setup checklist is built. */
export function SetupTab() {
  return <EmptyState title={setup.later} />;
}
