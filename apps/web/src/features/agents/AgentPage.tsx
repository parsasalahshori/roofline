import { G1_AGENTS_SHIPPED, hoursLabel, isScreenAgent, LAUNCH_AGENTS, moneyLabel, type AgentDetail, type ScreenAgent, type TimePeriod } from '@roofline/shared';
import { Banner, EmptyState, KpiTile, Page, Panel, Skeleton, Tag, UiLink } from '@roofline/ui';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { agentPage, agents, agentsCommon, agentsDash, agentsWindow } from '../../copy/agents.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { shell } from '../../copy/shell.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { NotFoundWindow } from '../../shell/NotFoundWindow.tsx';
import { InlineError } from '../approvals/InlineError.tsx';
import { agentStatus } from './agentStatus.ts';
import styles from './AgentPage.module.css';
import { useAgentDetail } from './api.ts';
import { ClaimsBoard } from './ClaimsBoard.tsx';
import { rateLabel } from './money.ts';
import { PauseSwitch } from './PauseSwitch.tsx';
import { PeriodPicker } from './PeriodPicker.tsx';
import { RecentTasks } from './RecentTasks.tsx';
import { RulesList } from './RulesList.tsx';
import { RunNowButton } from './RunNowButton.tsx';
import { agentFromSlug, type PageAgent } from './slugs.ts';
import { TimeBreakdown } from './TimeBreakdown.tsx';

/** Claims, Scheduler and Follow-up cannot run while paused (GX-E), so their page offers no Run now then. */
const G1_SCREEN_AGENTS: readonly ScreenAgent[] = ['claims', 'scheduler', 'follow_up'];

/** One agent's page: the title and the way back, then what it saved, what it did, what it may do and its controls. */
function AgentFrame({ agent, actions, stats, children }: { agent: PageAgent; actions?: ReactNode; stats?: ReactNode; children: ReactNode }) {
  return (
    <Page
      title={AGENT_LABEL[agent]}
      subtitle={isScreenAgent(agent) ? agentsDash.blurb[agent] : undefined}
      crumbs={[{ label: WINDOW_COPY.agents.title, href: '/agents' }, { label: AGENT_LABEL[agent] }]}
      crumbsLabel={shell.crumbsLabel}
      actions={actions}
      stats={stats}
    >
      {children}
    </Page>
  );
}

/** One agent's page: time saved, what it does, pause and run controls, and its recent work. */
export function AgentPage({ agent }: { agent: PageAgent }) {
  const launched = isScreenAgent(agent) && (G1_AGENTS_SHIPPED || (LAUNCH_AGENTS as readonly string[]).includes(agent));
  if (!isScreenAgent(agent) || !launched) return <ComingSoonPage agent={agent} />;
  return <ScreenAgentPage agent={agent} />;
}

function ComingSoonPage({ agent }: { agent: PageAgent }) {
  return (
    <AgentFrame agent={agent}>
      <Panel as="div">
        <EmptyState title={agents.agentComingSoon} />
      </Panel>
    </AgentFrame>
  );
}

/** The numbers over the page: what the agent saved in the period (an estimate), what it finished today and how often it succeeds. */
function PageStats({ d, owner, busy }: { d: AgentDetail; owner: boolean; busy: boolean }) {
  const rate = d.hourlyRateCents;
  return (
    <div className={styles.stats} aria-busy={busy}>
      <KpiTile
        label={`${agentPage.timeSaved} ${agentsCommon.estimate}`}
        value={hoursLabel(d.minutesInPeriod)}
        meta={
          rate === null ? undefined : (
            <>
              {`${moneyLabel(d.minutesInPeriod, rate)} ${agentsCommon.staffTime} ${rateLabel(rate)}${agentsCommon.perHour} ${agentsCommon.estimate}`}
              {owner ? (
                <>
                  {' '}
                  <UiLink href={agentsCommon.changeRateHref} className={styles.link}>
                    {agentsCommon.changeRate}
                  </UiLink>
                </>
              ) : null}
            </>
          )
        }
      />
      <KpiTile label={agentsWindow.finishedToday} value={d.card.finishedToday} />
      <KpiTile
        label={agentsWindow.successRate}
        value={d.card.successRate === null ? '-' : `${Math.round(d.card.successRate * 100)}%`}
        meta={d.card.successRate === null ? agentsWindow.successRateNone : undefined}
      />
    </div>
  );
}

function ScreenAgentPage({ agent }: { agent: ScreenAgent }) {
  const [period, setPeriod] = useState<TimePeriod>('month');
  const detail = useAgentDetail(agent, period);
  const me = useMe();
  const d = detail.data;
  const owner = me.data?.role === 'owner';
  const comingSoon = d !== undefined && (d.card.status === 'coming_soon' || d.runNow.kind === 'coming_soon');
  const live = d !== undefined && !comingSoon;

  return (
    <AgentFrame
      agent={agent}
      actions={live ? <PeriodPicker value={period} onChange={setPeriod} /> : undefined}
      stats={live ? <PageStats d={d} owner={owner} busy={detail.isPlaceholderData} /> : undefined}
    >
      {detail.isPending ? (
        <div className={styles.loading} role="status" aria-label={agentPage.loading}>
          <Skeleton lines={4} />
        </div>
      ) : !d ? (
        <InlineError tag={agentsCommon.errorTag} message={agentPage.loadError} retryLabel={agentsCommon.retry} onRetry={() => void detail.refetch()} />
      ) : comingSoon ? (
        <Panel as="div">
          <EmptyState title={agents.agentComingSoon} />
        </Panel>
      ) : (
        <div className={styles.content} aria-busy={detail.isPlaceholderData}>
          {detail.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null}
          {/* The claims are what Claims is for: its board comes first, ahead of the long list of recent work */}
          {agent === 'claims' ? <ClaimsBoard /> : null}
          {/* The controls and the rules come first for a screen reader and on a narrow screen; a wide one puts them at the right */}
          <div className={styles.layout} data-dim={detail.isPlaceholderData ? 'true' : undefined}>
            <div className={styles.side}>
              <ControlsPanel agent={agent} d={d} owner={owner} />
              <Panel title={agentPage.rulesTitle}>
                <RulesList rules={d.rules} />
              </Panel>
            </div>
            <div className={styles.main}>
              <TimeBreakdown rows={d.breakdown} />
              <RecentTasks tasks={d.recentTasks} />
            </div>
          </div>
        </div>
      )}
    </AgentFrame>
  );
}

/** Pause or turn on, and Run now: the two things a person can do to an agent. */
function ControlsPanel({ agent, d, owner }: { agent: ScreenAgent; d: AgentDetail; owner: boolean }) {
  const status = agentStatus(d.card);
  const paused = d.paused !== null;
  // A paused Claims, Scheduler or Follow-up agent cannot run (the server answers 409), so it offers no Run now.
  const offersRun = !(G1_SCREEN_AGENTS.includes(agent) && paused);
  return (
    <Panel
      title={agentPage.controlsTitle}
      tag={
        <Tag tone={status.tone} icon={status.icon}>
          {status.word}
        </Tag>
      }
    >
      <div className={styles.controls}>
        <PauseSwitch agent={agent} paused={d.paused} rules={d.rules} isOwner={owner} />
        {offersRun ? <RunNowButton agent={agent} runNow={d.runNow} paused={paused} /> : null}
      </div>
    </Panel>
  );
}

/** The /agents/:agent route: a known agent gets its page, anything else the not-found page. */
export function AgentRoute() {
  const agent = agentFromSlug(useParams().agent);
  if (!agent) return <NotFoundWindow />;
  return <AgentPage agent={agent} />;
}
