import { hoursLabel, moneyLabel } from '@roofline/shared';
import { Banner, Button, Skeleton } from '@roofline/ui';
import { agentsWindow } from '../../copy/agents.ts';
import { AgentCard } from './AgentCard.tsx';
import { AgentsTabs } from './AgentsTabs.tsx';
import { useAgentsOverview } from './api.ts';
import styles from './AgentsWindow.module.css';

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The Agents overview: honest month totals (always marked as estimates) and one card per agent. */
export function AgentsWindow() {
  const overview = useAgentsOverview();
  const data = overview.data;

  return (
    <>
      <AgentsTabs current="overview" />
      {overview.isError ? (
        <Banner tone="danger">{agentsWindow.loadError}</Banner>
      ) : !data ? (
        <div className={styles.loading}>
          <Skeleton lines={2} />
          <div className={styles.grid}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} height="8rem" />
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.totals}>
            <p className={styles.totalsLine}>
              {`${capitalise(hoursLabel(data.minutesThisMonth))} ${agentsWindow.totalsSaved} ${agentsWindow.estimate} ${agentsWindow.separator} ${moneyLabel(data.minutesThisMonth, data.hourlyRateCents)}`}
            </p>
            <Button variant="ghost" href={agentsWindow.howWeCountHref}>
              {agentsWindow.howWeCount}
            </Button>
          </div>
          <section className={styles.grid} aria-label={agentsWindow.gridLabel}>
            {data.cards.map((card) => (
              <AgentCard key={card.agent} card={card} hourlyRateCents={data.hourlyRateCents} />
            ))}
          </section>
        </div>
      )}
    </>
  );
}
