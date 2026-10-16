import { useId } from 'react';
import { Button, Tag, UiLink } from '@roofline/ui';
import type { AgentCard as AgentCardData, RuleSentence } from '@roofline/shared';
import { agentsDash } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AgentGlyph } from './AgentGlyph.tsx';
import { agentStatus } from './agentStatus.ts';
import { agoWords, wholeHours } from './agentTheme.ts';
import { DayBars } from './DayBars.tsx';
import { PauseSwitch } from './PauseSwitch.tsx';
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
  /** Where the agent's own page is. Given on a phone, where the card opens that page: there is no panel beside the cards to pick for. */
  href?: string;
};

/**
 * One agent on the dashboard: its glyph and name with the switch, its status, today's number, success and hours saved,
 * the last two weeks and its latest action. The whole card picks the agent (a stretched button under the controls); on a
 * phone it opens the agent's page instead.
 */
export function AgentCard({ card, minutesThisWeek, latest, selected, onSelect, isOwner, rules, now, href }: AgentCardProps) {
  const id = useId();
  const name = AGENT_LABEL[card.agent];
  const soon = card.status === 'coming_soon';
  const paused = card.status === 'paused';
  // Something waits on a person: the card says so, with the count, instead of "Running".
  const status = agentStatus(card);
  return (
    <li className={styles.item}>
      <article className={styles.card} data-selected={selected ? 'true' : undefined} data-status={card.status} aria-labelledby={`${id}-name`}>
        <div className={styles.head}>
          <AgentGlyph agent={card.agent} size="md" />
          <h3 className={styles.name} id={`${id}-name`}>
            {href === undefined ? (
              <Button variant="ghost" className={styles.pick} aria-pressed={selected} aria-label={`${agentsDash.selectHint} ${name}`} onClick={onSelect}>
                {name}
              </Button>
            ) : (
              <UiLink href={href} className={styles.pick} aria-label={`${agentsDash.openAgent} ${name}`}>
                {name}
              </UiLink>
            )}
          </h3>
          {soon ? null : (
            // Touching the switch also picks the card, so the panel (and the turn-on rules) are this agent's.
            <span className={styles.toggle} onFocusCapture={onSelect} onPointerDownCapture={onSelect}>
              <PauseSwitch variant="card" agent={card.agent} paused={paused ? { at: '', byName: null } : null} isOwner={isOwner} rules={rules} />
            </span>
          )}
        </div>
        <div className={styles.statusRow}>
          <Tag tone={status.tone} icon={status.icon}>
            {status.word}
          </Tag>
          {card.waitingCount > 0 ? <span className={styles.waiting}>{agentsDash.waitingCount(card.waitingCount)}</span> : null}
        </div>
        <p className={styles.count}>{card.finishedToday}</p>
        <p className={styles.countLabel}>{agentsDash.tasksTodayLine}</p>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt className="visually-hidden">{agentsDash.successLine}</dt>
            <dd>
              {card.successRate === null ? (
                <span className={styles.muted}>{agentsDash.noSuccess}</span>
              ) : (
                <>
                  <span className={styles.value}>{`${Math.round(card.successRate * 100)}%`}</span>
                  <span className={styles.muted}>{agentsDash.successLine}</span>
                </>
              )}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt className="visually-hidden">{agentsDash.savedLine}</dt>
            <dd>
              {minutesThisWeek === null ? null : (
                <>
                  <span className={styles.value}>{`${agentsDash.about} ${wholeHours(minutesThisWeek)} ${agentsDash.hoursUnit}`}</span>
                  <span className={styles.muted}>{agentsDash.savedLine}</span>
                </>
              )}
            </dd>
          </div>
        </dl>
        {card.last14Days.length > 0 ? <DayBars days={card.last14Days} label={agentsDash.cardSparkLabel} /> : null}
        <p className={styles.latest}>
          {latest === null ? (
            <span className={styles.muted}>{agentsDash.latestNone}</span>
          ) : (
            <>
              <span className={styles.latestText}>{latest.text}</span> <span className={styles.ago}>{agoWords(latest.at, now)}</span>
            </>
          )}
        </p>
      </article>
    </li>
  );
}
