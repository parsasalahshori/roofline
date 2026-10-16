import type { AgentCard } from '@roofline/shared';
import type { IconName, TagTone } from '@roofline/ui';
import { agentsDash } from '../../copy/agents.ts';

/** How an agent's state is drawn: its words, a tone and a glyph. A status is never only a colour. */
export type AgentStatusTag = { word: string; tone: TagTone; icon: IconName };

const STATUS: Record<'on' | 'waiting' | 'paused' | 'coming_soon', AgentStatusTag> = {
  on: { word: agentsDash.running, tone: 'ok', icon: 'bolt' },
  waiting: { word: agentsDash.waiting, tone: 'tape', icon: 'alert' },
  paused: { word: agentsDash.paused, tone: 'neutral', icon: 'minus' },
  coming_soon: { word: agentsDash.comingSoon, tone: 'neutral', icon: 'clock' },
};

/** Something waits on a person: the agent says Waiting, with tape yellow, instead of Running. A paused or coming-soon agent keeps its own state. */
export function agentStatus(card: Pick<AgentCard, 'status' | 'waitingCount'>): AgentStatusTag {
  const waiting = card.status === 'on' && card.waitingCount > 0;
  return STATUS[waiting ? 'waiting' : card.status];
}
