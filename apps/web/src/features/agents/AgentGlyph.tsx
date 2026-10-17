import type { Agent } from '@roofline/shared';
import { Icon } from '@roofline/ui';
import { AGENT_ICON } from './agentTheme.ts';
import styles from './AgentGlyph.module.css';

/** An agent's glyph: its line icon in ink on a sunken square, the same mark the approval card carries. Decoration, so it is hidden from a screen reader. */
export function AgentGlyph({ agent, size = 'sm' }: { agent: Agent; size?: 'sm' | 'md' }) {
  return (
    <span className={styles.glyph} data-size={size} aria-hidden="true">
      <Icon name={AGENT_ICON[agent]} size={size === 'md' ? 18 : 16} />
    </span>
  );
}
