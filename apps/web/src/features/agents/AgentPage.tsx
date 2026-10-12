import { EmptyState } from '@roofline/ui';
import { useParams } from 'react-router';
import { agents } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AppWindow } from '../../shell/AppWindow.tsx';
import { NotFoundWindow } from '../../shell/NotFoundWindow.tsx';
import { AgentsTabs } from './AgentsTabs.tsx';
import { agentFromSlug, type PageAgent } from './slugs.ts';

/** One agent's page (placeholder). */
export function AgentPage({ agent }: { agent: PageAgent }) {
  return (
    <>
      <AgentsTabs current="agent" />
      <EmptyState title={AGENT_LABEL[agent]} body={agents.agentComingSoon} />
    </>
  );
}

/** The /agents/:agent route: a known agent gets its page in the Agents window, anything else the not-found window. */
export function AgentRoute() {
  const agent = agentFromSlug(useParams().agent);
  if (!agent) return <NotFoundWindow />;
  return (
    <AppWindow app="agents">
      <AgentPage agent={agent} />
    </AppWindow>
  );
}
