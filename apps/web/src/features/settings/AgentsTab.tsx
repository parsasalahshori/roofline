import { TimeBaselines } from '../agents/TimeBaselines.tsx';
import { AgentRules } from './AgentRules.tsx';

/** The Agents settings tab: the agent rules form (G1) first, because it is what a person comes to change, then how we count time saved (A1). */
export function AgentsTab() {
  return (
    <>
      <AgentRules />
      <TimeBaselines />
    </>
  );
}
