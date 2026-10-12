import { hoursLabel, moneyLabel, type AgentCard as AgentCardData } from '@roofline/shared';
import { useId } from 'react';
import { Card, UiLink } from '@roofline/ui';
import { agentsCommon, agentsWindow } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { MiniChart } from './MiniChart.tsx';
import styles from './AgentCard.module.css';
import { agentSlug } from './slugs.ts';

/** One agent on the Agents window: a card that links to the agent's page. Time and money are always marked as estimates. */
export function AgentCard({ card, hourlyRateCents }: { card: AgentCardData; hourlyRateCents: number | null }) {
  const id = useId();
  const nameId = `${id}-name`;
  const timeId = `${id}-time`;
  const chipId = `${id}-chip`;
  const name = AGENT_LABEL[card.agent];
  const soon = card.status === 'coming_soon';
  return (
    <Card as="div">
      <UiLink href={`/agents/${agentSlug(card.agent)}`} aria-labelledby={soon ? `${nameId} ${chipId}` : `${nameId} ${chipId} ${timeId}`} className={styles.link}>
        <div className={styles.card}>
          <div className={styles.head}>
            <h3 className={styles.name} id={nameId}>{name}</h3>
            <span className={styles.chip} id={chipId} data-status={card.status}>
              {agentsWindow.status[card.status]}
            </span>
          </div>
          {soon ? (
            <p className={styles.line}>{agentsCommon.comingSoon}</p>
          ) : (
            <>
              <p className={styles.line}>
                <span>{agentsWindow.finishedToday}</span>
                <span>{card.finishedToday}</span>
              </p>
              <p className={styles.line} id={timeId}>
                <span>{agentsWindow.timeSaved}</span>
                <span>{hoursLabel(card.minutesThisMonth)}</span>
                <span>{agentsCommon.estimate}</span>
                {hourlyRateCents === null ? null : (
                  <>
                    <span>{agentsWindow.separator}</span>
                    <span>{`${moneyLabel(card.minutesThisMonth, hourlyRateCents)} ${agentsCommon.estimate}`}</span>
                  </>
                )}
              </p>
              <p className={styles.line}>
                <span>{agentsWindow.successRate}</span>
                <span>{card.successRate === null ? agentsWindow.successRateNone : `${Math.round(card.successRate * 100)}%`}</span>
              </p>
              <p className={`${styles.line} ${styles.muted}`}>{`${agentsWindow.notApproved} ${card.notApproved30d}`}</p>
              {card.waitingCount > 0 ? <p className={styles.line}>{`${agentsWindow.waiting} ${card.waitingCount}`}</p> : null}
              <MiniChart days={card.last14Days} label={agentsWindow.chartLabel} />
            </>
          )}
        </div>
      </UiLink>
    </Card>
  );
}
