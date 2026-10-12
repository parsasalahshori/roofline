import { TimeBaselines } from '../agents/TimeBaselines.tsx';
import { AgentRules } from './AgentRules.tsx';

/** The Agents settings tab: how we count time saved (A1), then the agent rules form (G1). */
export function AgentsTab() {
  return (
    <>
      <TimeBaselines />
      <AgentRules />
    </>
  );
}
