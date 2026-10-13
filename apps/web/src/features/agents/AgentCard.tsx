import { useId, type CSSProperties } from 'react';
import { Button } from '@roofline/ui';
import type { AgentCard as AgentCardData, RuleSentence } from '@roofline/shared';
import { agentsDash } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AgentIcon } from './AgentIcon.tsx';
import { AGENT_COLOR, agoWords, wholeHours } from './agentTheme.ts';
import { PauseSwitch } from './PauseSwitch.tsx';
import { Sparkline } from './Sparkline.tsx';
import styles from './AgentCard.module.css';

export type AgentCardProps = {
  card: AgentCardData;
  /** This week's minutes saved by the agent, from the dashboard numbers. */
  minutesThisWeek: number | null;
  /** The agent's newest action, from the dashboard numbers. */
  latest: { text: string; at: string } | null;
  selected: boolean;
  onSelect: () => void;
  isOwner: boolean;
  /** Rules the "turn on" sheet shows for an agent that is paused. */
  rules?: RuleSentence[];
  /** The clock for "11 min ago", so a render is repeatable. */
  now: number;
};

const STATUS_WORD = {
  on: agentsDash.running,
  waiting: agentsDash.running,
  paused: agentsDash.paused,
  coming_soon: agentsDash.comingSoon,
} as const;

/** One agent on the dashboard: name, running state and switch, today's number, success, hours saved, trend and latest action. */
export function AgentCard({ card, minutesThisWeek, latest, selected, onSelect, isOwner, rules, now }: AgentCardProps) {
  const id = useId();
  const name = AGENT_LABEL[card.agent];
  const soon = card.status === 'coming_soon';
  const paused = card.status === 'paused';
  const series = card.last14Days.map((d) => d.finished);
  return (
    <li className={styles.item} style={{ '--agent': AGENT_COLOR[card.agent] } as CSSProperties}>
      <span className={styles.node} aria-hidden="true">
        <AgentIcon agent={card.agent} size={20} />
      </span>
      <article className={styles.card} data-selected={selected ? 'true' : undefined} data-status={card.status} aria-labelledby={`${id}-name`}>
        <span className={styles.tab} aria-hidden="true" />
        <div className={styles.head}>
          <h3 className={styles.name} id={`${id}-name`}>
            <Button variant="ghost" className={styles.pick} aria-pressed={selected} onClick={onSelect}>
              <span className="visually-hidden">{`${agentsDash.selectHint} `}</span>
              <span>{name}</span>
            </Button>
          </h3>
        </div>
        <div className={styles.statusRow}>
          <span className={styles.status} data-status={card.status}>
            {STATUS_WORD[card.status]}
          </span>
          {soon ? null : (
            // Touching the switch also picks the card, so the panel (and the turn-on rules) are this agent's.
            <span className={styles.toggle} onFocusCapture={onSelect} onPointerDownCapture={onSelect}>
              <PauseSwitch
                variant="card"
                agent={card.agent}
                paused={paused ? { at: '', byName: null } : null}
                isOwner={isOwner}
                rules={rules}
              />
            </span>
          )}
        </div>
        <p className={styles.big}>{card.finishedToday}</p>
        <p className={styles.bigLabel}>{agentsDash.tasksTodayLine}</p>
        <dl className={styles.stats}>
          <div className={styles.stat}>
            <dt className="visually-hidden">{agentsDash.successLine}</dt>
            <dd>
              {card.successRate === null ? (
                <span className={styles.muted}>{agentsDash.noSuccess}</span>
              ) : (
                <>
                  <span>{`${Math.round(card.successRate * 100)}%`}</span>
                  <span className={styles.muted}>{agentsDash.successLine}</span>
                </>
              )}
            </dd>
          </div>
          <div className={styles.stat}>
            <dt className="visually-hidden">{agentsDash.savedLine}</dt>
            <dd>
              {minutesThisWeek === null ? null : (
                <>
                  <span>{`${wholeHours(minutesThisWeek)} ${agentsDash.hoursUnit}`}</span>
                  <span className={styles.muted}>{agentsDash.savedLine}</span>
                </>
              )}
            </dd>
          </div>
        </dl>
        <div className={styles.spark}>
          <Sparkline values={series} label={agentsDash.cardSparkLabel} width={150} height={34} />
        </div>
        <p className={styles.latest}>
          {latest === null ? (
            <span className={styles.muted}>{agentsDash.latestNone}</span>
          ) : (
            <>
              <span className={styles.latestText}>{latest.text}</span>{' '}
              <span className={styles.muted}>{agoWords(latest.at, now)}</span>
            </>
          )}
        </p>
      </article>
    </li>
  );
}
