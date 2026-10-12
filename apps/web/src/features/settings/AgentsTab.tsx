import { EmptyState } from '@roofline/ui';
import { agents } from '../../copy/agents.ts';
import { AgentRules } from './AgentRules.tsx';

/** The Agents settings tab. A1 Task 8 skeleton: one line. Task 12 fills it with 'How we count time saved'. */
export function AgentsTab() {
  return (
    <>
      <EmptyState title={agents.settingsComingSoon} />
      <AgentRules />
    </>
  );
}
