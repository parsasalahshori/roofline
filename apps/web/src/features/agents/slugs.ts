import { AGENTS, type Agent } from '@roofline/shared';

/** The agents that have a page of their own. The system actor (`system`) does not. */
export type PageAgent = Exclude<Agent, 'system'>;
export const PAGE_AGENTS: readonly PageAgent[] = AGENTS.filter((agent): agent is PageAgent => agent !== 'system');

/** The address part for an agent: the enum value with hyphens (`storm_scout` is `storm-scout`). */
export function agentSlug(agent: PageAgent): string {
  return agent.replaceAll('_', '-');
}

/** The agent a slug names, or undefined for an unknown slug (and for `system`, which has no page). */
export function agentFromSlug(slug: string | undefined): PageAgent | undefined {
  return PAGE_AGENTS.find((agent) => agentSlug(agent) === slug);
}
