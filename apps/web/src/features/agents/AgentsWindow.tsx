import { Banner, Button, Skeleton, UiLink } from '@roofline/ui';
import { useState } from 'react';
import type { ScreenAgent } from '@roofline/shared';
import { useMe } from '../../api/hooks.ts';
import { agentsCommon, agentsDash, agentsWindow } from '../../copy/agents.ts';
import { AgentCard } from './AgentCard.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { AgentsTabs } from './AgentsTabs.tsx';
import { DASH_ORDER } from './agentTheme.ts';
import { useAgentDetail, useAgentsDashboard, useAgentsOverview } from './api.ts';
import { KpiTiles } from './KpiTiles.tsx';
import { RoofDiagram } from './RoofDiagram.tsx';
import styles from './AgentsWindow.module.css';

/** The agent whose panel is open when the window first shows. */
const FIRST_SELECTED: ScreenAgent = 'front_desk';

/**
 * The Agents dashboard: header tiles, the roof diagram with real handoffs, one card per agent and the panel of the
 * agent you picked. Money and time are estimates; every number comes from the overview and dashboard endpoints.
 */
export function AgentsWindow() {
  const overview = useAgentsOverview();
  const dashboard = useAgentsDashboard();
  const data = overview.data;
  const role = useMe().data?.role;
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
          <div className={styles.skeletons}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} height="8rem" />
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.body}>
          {overview.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null}
          <KpiTiles cards={data.cards} dashboard={numbers} />
          <div className={styles.split}>
            <div className={styles.main}>
              <div className={styles.handoffs}>
                <p className={styles.badge}>
                  <span className={styles.count}>{numbers?.handoffsToday ?? 0}</span>
                  <span>{numbers?.handoffsToday === 1 ? agentsDash.handoffOne : agentsDash.handoffsSuffix}</span>
                </p>
                <p className={styles.hint}>{agentsDash.handoffsHint}</p>
              </div>
              <div className={styles.roof}>
                <RoofDiagram handoffs={numbers?.handoffs ?? []} selected={selected} />
              </div>
              <section className={styles.cards} aria-labelledby="agents-grid-heading">
                <h2 id="agents-grid-heading" className="visually-hidden">
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
                        selected={agent === selected}
                        onSelect={() => setSelected(agent)}
                        isOwner={role === 'owner'}
                        rules={agent === selected ? detail.data?.rules : undefined}
                        now={now}
                      />
                    );
                  })}
                </ul>
              </section>
              <div className={styles.links}>
                {role === 'rep' ? null : (
                  <Button variant="ghost" href={agentsWindow.howWeCountHref}>
                    {agentsWindow.howWeCount}
                  </Button>
                )}
                {data.hourlyRateCents !== null && role === 'owner' ? (
                  <UiLink href={agentsCommon.changeRateHref}>{agentsCommon.changeRate}</UiLink>
                ) : null}
              </div>
            </div>
            <div className={styles.side}>
              <AgentPanel agent={selected} now={now} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
