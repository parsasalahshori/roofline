import { AgentsTabs } from './AgentsTabs.tsx';
import { WaitingList } from './WaitingList.tsx';

/** The "Waiting on you" tab. */
export function WaitingWindow() {
  return (
    <>
      <AgentsTabs current="waiting" />
      <WaitingList />
    </>
  );
}
