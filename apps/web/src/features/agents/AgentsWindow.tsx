import { useState } from 'react';
import { hoursLabel } from '@roofline/shared';
import { Banner, Button, Skeleton, UiLink } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { agentsCommon, agentsWindow } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AgentCard } from './AgentCard.tsx';
import { AgentsTabs } from './AgentsTabs.tsx';
import { useAgentsOverview } from './api.ts';
import { moneyLineText } from './money.ts';
import { agentSlug } from './slugs.ts';
import styles from './AgentsWindow.module.css';

const MARKS: Record<string, string> = {
  storm_scout: 'M7 15a5 5 0 1 1 9-4 3 3 0 0 1 0 6 M9 18v2 M13 17v3 M17 19v2',
  front_desk: 'M7 3 4 5c-2 6 9 17 15 15l2-3-5-4-2 2-5-5 2-2-4-5 M15 3a7 7 0 0 1 6 6 M15 7a3 3 0 0 1 2 2',
  estimator: 'm8 3 13 13-5 5L3 8l5-5 M8 7l-2 2 M11 10l-2 2 M14 13l-2 2 M17 16l-2 2',
  claims: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3 M8 12l3 3 5-6',
  scheduler: 'M5 5h14v15H5V5 M8 3v4 M16 3v4 M5 10h14 M8 14h3 M8 17h6',
  follow_up: 'M20 11a8 8 0 0 1-8 8H4l2-4a8 8 0 1 1 14-4',
};
const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Overview figures use only the role-scoped server snapshot. Selection never runs or changes an agent. */
export function AgentsWindow() {
  const overview = useAgentsOverview();
  const data = overview.data;
  const role = useMe().data?.role;
  const [selected, setSelected] = useState<string | null>(null);
  const focused = data?.cards.find((card) => card.agent === selected) ?? data?.cards[0];

  return (
    <div className={styles.root}>
      <AgentsTabs current="overview" />
      {data === undefined && overview.isError ? (
        <div className={styles.loading}>
          <Banner tone="danger">{agentsWindow.loadError}</Banner>
          <div><Button variant="ghost" onClick={() => void overview.refetch()}>{agentsCommon.retry}</Button></div>
        </div>
      ) : !data ? (
        <div className={styles.loading} role="status" aria-label={agentsWindow.loading}>
          <Skeleton lines={2} />
          <div className={styles.grid}>{[0, 1, 2].map((index) => <Skeleton key={index} height="8rem" />)}</div>
        </div>
      ) : (
        <div className={styles.body}>
          {overview.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null}
          <div className={styles.stats}>
            <div className={styles.stat}><span>{agentsWindow.tasksToday}</span><strong>{data.cards.reduce((sum, card) => sum + card.finishedToday, 0)}</strong></div>
            <div className={styles.stat}><span>{agentsWindow.activeAgents}</span><strong>{data.cards.filter((card) => card.status === 'on' || card.status === 'waiting').length}</strong></div>
            <div className={styles.stat}><span>{agentsWindow.needsReview}</span><strong>{data.cards.reduce((sum, card) => sum + card.waitingCount, 0)}</strong></div>
            <div className={`${styles.stat} ${styles.totals}`}>
              <p className={styles.totalsLine}>
                {`${capitalise(hoursLabel(data.minutesThisMonth))} ${agentsWindow.totalsSaved} ${agentsCommon.estimate}${data.hourlyRateCents === null ? '' : ` ${agentsWindow.separator} ${moneyLineText(data.minutesThisMonth, data.hourlyRateCents)} ${agentsCommon.estimate}`}`}
              </p>
              <div className={styles.totalsLinks}>
                {data.hourlyRateCents !== null && role === 'owner' ? <UiLink href={agentsCommon.changeRateHref}>{agentsCommon.changeRate}</UiLink> : null}
                {role === 'owner' || role === 'office' ? <UiLink href={agentsWindow.howWeCountHref}>{agentsWindow.howWeCount}</UiLink> : null}
              </div>
            </div>
          </div>
          <div className={styles.workspace}>
            <div className={styles.team}>
              <div className={styles.teamHeading}><h2>{agentsWindow.teamIntro}</h2><p>{agentsWindow.teamHelp}</p></div>
              <div className={styles.roof}>
                <svg className={styles.roofDrawing} viewBox="0 0 900 200" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                  <path d="M0 192 L450 12 L900 192 L900 200 L0 200 Z" className={styles.roofFill} />
                  <path d="M0 192 L450 12 L900 192 M0 200 L450 20 L900 200" className={styles.roofStroke} />
                </svg>
                <div className={styles.nodes} role="group" aria-label={agentsWindow.inspectLabel}>
                  {data.cards.map((card, index) => (
                    <Button key={card.agent} variant="ghost" className={styles.node} data-agent={card.agent} data-position={index}
                      aria-label={agentsWindow.inspect(AGENT_LABEL[card.agent])} aria-pressed={focused?.agent === card.agent}
                      onClick={() => setSelected(card.agent)}>
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={MARKS[card.agent]} /></svg>
                    </Button>
                  ))}
                </div>
              </div>
              <section className={styles.grid} aria-labelledby="agents-grid-heading">
                <h2 id="agents-grid-heading" className="visually-hidden">{agentsWindow.gridLabel}</h2>
                {data.cards.map((card) => <AgentCard key={card.agent} card={card} hourlyRateCents={data.hourlyRateCents} />)}
              </section>
            </div>
            {focused ? (
              <section className={styles.summary} aria-label={agentsWindow.snapshot}>
                <div className={styles.summaryHeader}>
                  <span className={styles.agentMark} data-agent={focused.agent} aria-hidden="true">{AGENT_LABEL[focused.agent].slice(0, 1)}</span>
                  <div><h2>{AGENT_LABEL[focused.agent]}</h2><span className={styles.status} data-status={focused.status}>{agentsWindow.status[focused.status]}</span></div>
                </div>
                <p>{agentsWindow.descriptions[focused.agent] ?? agentsWindow.descriptions.custom}</p>
                <Button href={`/agents/${agentSlug(focused.agent)}`} className={styles.openAgent}>{agentsWindow.openAgent(AGENT_LABEL[focused.agent])}</Button>
                <div className={styles.approvalNote}><p>{agentsWindow.approvalNote}</p><Button href="/agents/waiting" variant="ghost">{agentsWindow.reviewWork}</Button></div>
                {role === 'owner' || role === 'office' ? <UiLink href="/settings/agents">{agentsWindow.settings}</UiLink> : null}
              </section>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
