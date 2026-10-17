import { ActivityFeed } from './ActivityFeed.tsx';
import { AgentsTabs } from './AgentsTabs.tsx';

/** The Agents page's Feed tab. */
export function FeedWindow() {
  return (
    <>
      <AgentsTabs current="feed" />
      <ActivityFeed />
    </>
  );
}
