import type { ScreenAgent } from '@roofline/shared';
import { Icon, Panel } from '@roofline/ui';
import { agentsDash } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AgentGlyph } from './AgentGlyph.tsx';
import { agoWords } from './agentTheme.ts';
import styles from './Handoffs.module.css';

export type Handoff = { from: ScreenAgent; to: ScreenAgent; label: string; at: string };

/** How many of today's handoffs are listed; the count over the list is all of them. */
const SHOWN = 5;

/** Jobs that moved from one agent to the next today: the job, who passed it, who took it, and when. A list, not a picture. */
export function Handoffs({ handoffs, total, now }: { handoffs: ReadonlyArray<Handoff>; total: number; now: number }) {
  return (
    <Panel title={agentsDash.handoffsTitle} tag={total} padded={false}>
      {handoffs.length === 0 ? (
        <p className={styles.empty}>{agentsDash.handoffsEmpty}</p>
      ) : (
        <ul className={styles.list} aria-label={agentsDash.handoffsListLabel}>
          {handoffs.slice(0, SHOWN).map((handoff, index) => (
            <li key={`${handoff.at}-${index}`} className={styles.row}>
              <span className={styles.pair} aria-hidden="true">
                <AgentGlyph agent={handoff.from} />
                <Icon name="arrow" size={16} />
                <AgentGlyph agent={handoff.to} />
              </span>
              <span className={styles.text}>
                <strong className={styles.job}>{handoff.label}</strong>
                <span className={styles.meta}>
                  {`${AGENT_LABEL[handoff.from]} ${agentsDash.handedTo} ${AGENT_LABEL[handoff.to]}`}
                  <span className={styles.when}>{agoWords(handoff.at, now)}</span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
