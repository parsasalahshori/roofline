import { hoursLabel } from '@roofline/shared';
import { Banner, Button, Skeleton, UiLink } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { agentsCommon, agentsWindow } from '../../copy/agents.ts';
import { AgentCard } from './AgentCard.tsx';
import { AgentsTabs } from './AgentsTabs.tsx';
import { useAgentsOverview } from './api.ts';
import { moneyLineText } from './money.ts';
import styles from './AgentsWindow.module.css';

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The Agents overview: honest month totals (always marked as estimates) and one card per agent. */
export function AgentsWindow() {
  const overview = useAgentsOverview();
  const data = overview.data;
  const role = useMe().data?.role;

  return (
    <>
      <AgentsTabs current="overview" />
      {data === undefined && overview.isError ? (
        <div className={styles.loading}>
          <Banner tone="danger">{agentsWindow.loadError}</Banner>
          <div>
            <Button variant="ghost" onClick={() => void overview.refetch()}>
              {agentsCommon.retry}
            </Button>
          </div>
        </div>
      ) : !data ? (
        <div className={styles.loading} role="status" aria-label={agentsWindow.loading}>
          <Skeleton lines={2} />
          <div className={styles.grid}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} height="8rem" />
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.body}>
          {overview.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null}
          <div className={styles.totals}>
            <div className={styles.totalsText}>
              <p className={styles.totalsLine}>
                {`${capitalise(hoursLabel(data.minutesThisMonth))} ${agentsWindow.totalsSaved} ${agentsCommon.estimate}${data.hourlyRateCents === null ? '' : ` ${agentsWindow.separator} ${moneyLineText(data.minutesThisMonth, data.hourlyRateCents)} ${agentsCommon.estimate}`}`}
              </p>
              {data.hourlyRateCents !== null && role === 'owner' ? (
                <UiLink href={agentsCommon.changeRateHref}>{agentsCommon.changeRate}</UiLink>
              ) : null}
            </div>
            {role === 'rep' ? null : (
              <Button variant="ghost" href={agentsWindow.howWeCountHref}>
                {agentsWindow.howWeCount}
              </Button>
            )}
          </div>
          <section className={styles.grid} aria-labelledby="agents-grid-heading">
            <h2 id="agents-grid-heading" className="visually-hidden">
              {agentsWindow.gridLabel}
            </h2>
            {data.cards.map((card) => (
              <AgentCard key={card.agent} card={card} hourlyRateCents={data.hourlyRateCents} />
            ))}
          </section>
        </div>
      )}
    </>
  );
}
