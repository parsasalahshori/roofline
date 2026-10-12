import { EmptyState } from '@roofline/ui';
import { agents } from '../../copy/agents.ts';
import { AgentsTabs } from './AgentsTabs.tsx';

/** Placeholder until the real screen is built. */
export function FeedWindow() {
  return (
    <>
      <AgentsTabs current="feed" />
      <EmptyState title={agents.feedComingSoon} />
    </>
  );
}
