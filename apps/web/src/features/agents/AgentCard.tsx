import { G1_AGENTS, hoursLabel, moneyLabel, type AgentCard as AgentCardData } from '@roofline/shared';
import { Card, UiLink } from '@roofline/ui';
import { agentsWindow } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { MiniChart } from './MiniChart.tsx';
import styles from './AgentCard.module.css';
import { agentSlug } from './slugs.ts';

/** One agent on the Agents window: a card that links to the agent's page. Time and money are always marked as estimates. */
export function AgentCard({ card, hourlyRateCents }: { card: AgentCardData; hourlyRateCents: number }) {
  const name = AGENT_LABEL[card.agent];
  const turnOn = card.status === 'paused' && (G1_AGENTS as readonly string[]).includes(card.agent);
  const soon = card.status === 'coming_soon';
  return (
    <Card as="div" className={styles.card}>
      <UiLink href={`/agents/${agentSlug(card.agent)}`} aria-label={name} className={styles.link}>
        <div className={styles.card}>
          <div className={styles.head}>
            <h3 className={styles.name}>{name}</h3>
            <span className={styles.chip} data-status={card.status}>
              {agentsWindow.status[card.status]}
            </span>
          </div>
          {soon ? (
            <p className={styles.line}>{agentsWindow.comingSoon}</p>
          ) : (
            <>
              <p className={styles.line}>
                <span>{agentsWindow.finishedToday}</span>
                <span>{card.finishedToday}</span>
              </p>
              <p className={styles.line}>
                <span>{agentsWindow.timeSaved}</span>
                <span>{hoursLabel(card.minutesThisMonth)}</span>
                <span>{agentsWindow.estimate}</span>
                <span>{agentsWindow.separator}</span>
                <span>{moneyLabel(card.minutesThisMonth, hourlyRateCents)}</span>
              </p>
              <p className={styles.line}>
                <span>{agentsWindow.successRate}</span>
                <span>{card.successRate === null ? agentsWindow.successRateNone : `${Math.round(card.successRate * 100)}%`}</span>
              </p>
              <p className={`${styles.line} ${styles.muted}`}>{`${agentsWindow.notApproved} ${card.notApproved30d}`}</p>
              {card.waitingCount > 0 ? <p className={styles.line}>{`${agentsWindow.waiting} ${card.waitingCount}`}</p> : null}
              {turnOn ? <p className={styles.line}><span>{agentsWindow.turnOnHint}</span></p> : null}
              <MiniChart days={card.last14Days} label={agentsWindow.chartLabel} />
            </>
          )}
        </div>
      </UiLink>
    </Card>
  );
}
