import type { Agent } from '@roofline/shared';
import type { IconName } from '@roofline/ui';

/** The glyph of each agent: drawn ink on a sunken square wherever an agent speaks (an approval card, the feed). */
export const AGENT_ICON: Record<Agent, IconName> = {
  storm_scout: 'storm',
  estimator: 'ruler',
  front_desk: 'phone',
  claims: 'doc',
  scheduler: 'cal',
  follow_up: 'msg',
  system: 'gear',
};
