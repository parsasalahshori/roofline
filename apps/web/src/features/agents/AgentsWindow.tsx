import { Banner, Skeleton, UiLink } from '@roofline/ui';
import { useState } from 'react';
import type { ScreenAgent } from '@roofline/shared';
import { useMe } from '../../api/hooks.ts';
import { agentsCommon, agentsWindow } from '../../copy/agents.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { InlineError } from '../approvals/InlineError.tsx';
import { AgentCard } from './AgentCard.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { AgentsTabs } from './AgentsTabs.tsx';
import { DASH_ORDER } from './agentTheme.ts';
import { useAgentDetail, useAgentsDashboard, useAgentsOverview } from './api.ts';
import { Handoffs } from './Handoffs.tsx';
import { KpiTiles } from './KpiTiles.tsx';
import { agentSlug } from './slugs.ts';
import styles from './AgentsWindow.module.css';

/** The agent whose panel is open when the window first shows. */
const FIRST_SELECTED: ScreenAgent = 'front_desk';

/** While the agents load: the tiles and the cards in the places they will take. */
function OverviewSkeleton() {
  return (
    <div className={styles.loading} role="status" aria-label={agentsWindow.loading}>
      <div className={styles.skeletonTiles}>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className={styles.skeleton}>
            <Skeleton width="55%" height="0.75rem" />
            <Skeleton width="40%" height="1.75rem" />
          </div>
        ))}
      </div>
      <div className={styles.list}>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className={styles.skeleton}>
            <Skeleton width="50%" height="1.25rem" />
            <Skeleton width="30%" height="2rem" />
            <Skeleton lines={2} height="0.875rem" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The Agents overview: the totals as tiles, one card per agent with the panel of the one you picked beside them (on a
 * phone a card opens the agent's own page), and the jobs handed from agent to agent today. Money and time are
 * estimates; every number comes from the overview and dashboard endpoints.
 */
export function AgentsWindow() {
  const overview = useAgentsOverview();
  const dashboard = useAgentsDashboard();
  const data = overview.data;
  const role = useMe().data?.role;
  const phone = useIsPhone();
  const [selected, setSelected] = useState<ScreenAgent>(FIRST_SELECTED);
  const [clock] = useState(() => Date.now());
  // The same query the panel uses: its rules fill in the "turn on" sheet of a paused agent.
  const detail = useAgentDetail(selected, 'week');
  const now = dashboard.dataUpdatedAt > 0 ? dashboard.dataUpdatedAt : clock;
  const numbers = dashboard.data;

  return (
    <>
      <AgentsTabs current="overview" />
      {data === undefined && overview.isError ? (
        <InlineError tag={agentsCommon.errorTag} message={agentsWindow.loadError} retryLabel={agentsCommon.retry} onRetry={() => void overview.refetch()} />
      ) : !data ? (
        <OverviewSkeleton />
      ) : (
        <div className={styles.body}>
          {overview.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null}
          <KpiTiles cards={data.cards} dashboard={numbers} />
          <div className={styles.split}>
            <div className={styles.main}>
              <section className={styles.cards} aria-labelledby="agents-grid-heading">
                <h2 id="agents-grid-heading" className={styles.heading}>
                  {agentsWindow.gridLabel}
                </h2>
                <ul className={styles.list}>
                  {DASH_ORDER.map((agent) => {
                    const card = data.cards.find((c) => c.agent === agent);
                    if (!card) return null;
                    const info = numbers?.agents.find((a) => a.agent === agent);
                    return (
                      <AgentCard
                        key={agent}
                        card={card}
                        minutesThisWeek={info ? info.minutesThisWeek : null}
                        latest={info?.latest ?? null}
                        selected={!phone && agent === selected}
                        onSelect={() => setSelected(agent)}
                        isOwner={role === 'owner'}
                        rules={agent === selected ? detail.data?.rules : undefined}
                        now={now}
                        href={phone ? `/agents/${agentSlug(agent)}` : undefined}
                      />
                    );
                  })}
                </ul>
              </section>
              <Handoffs handoffs={numbers?.handoffs ?? []} total={numbers?.handoffsToday ?? 0} now={now} />
              <div className={styles.links}>
                {role === 'rep' ? null : (
                  <UiLink href={agentsWindow.howWeCountHref} className={styles.link}>
                    {agentsWindow.howWeCount}
                  </UiLink>
                )}
                {data.hourlyRateCents !== null && role === 'owner' ? (
                  <UiLink href={agentsCommon.changeRateHref} className={styles.link}>
                    {agentsCommon.changeRate}
                  </UiLink>
                ) : null}
              </div>
            </div>
            {phone ? null : (
              <div className={styles.side}>
                <AgentPanel agent={selected} now={now} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
