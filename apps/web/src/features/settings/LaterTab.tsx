import { EmptyState } from '@roofline/ui';
import { connections } from '../../copy/connections.ts';
import type { LaterTabKey } from './tabs.ts';

/** The line each tab that is not built yet shows. The vendor names in these lines live only in their copy files. */
const LATER: Record<LaterTabKey, string> = {
  connections: connections.later,
};

/** A Settings tab that is not built yet: one line saying what is coming. */
export function LaterTab({ tab }: { tab: LaterTabKey }) {
  return <EmptyState title={LATER[tab]} />;
}
