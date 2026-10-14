import { G1_AGENTS_SHIPPED, hoursLabel, isScreenAgent, LAUNCH_AGENTS, type ScreenAgent, type TimePeriod } from '@roofline/shared';
import { Banner, Button, EmptyState, Skeleton, UiLink } from '@roofline/ui';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { agentPage, agents, agentsCommon } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AppWindow } from '../../shell/AppWindow.tsx';
import { NotFoundWindow } from '../../shell/NotFoundWindow.tsx';
import styles from './AgentPage.module.css';
import { useAgentDetail } from './api.ts';
import { moneyLineText } from './money.ts';
import { AgentsTabs } from './AgentsTabs.tsx';
import { ClaimsBoard } from './ClaimsBoard.tsx';
import { PauseSwitch } from './PauseSwitch.tsx';
import { PeriodPicker } from './PeriodPicker.tsx';
import { RecentTasks } from './RecentTasks.tsx';
import { RulesList } from './RulesList.tsx';
import { RunNowButton } from './RunNowButton.tsx';
import { TimeBreakdown } from './TimeBreakdown.tsx';
import { agentFromSlug, type PageAgent } from './slugs.ts';

/** Claims, Scheduler and Follow-up cannot run while paused (GX-E), so their page offers no Run now then. */
const G1_SCREEN_AGENTS: readonly ScreenAgent[] = ['claims', 'scheduler', 'follow_up'];

/** One agent's page: time saved, what it does, pause and run controls, and its recent work. */
export function AgentPage({ agent }: { agent: PageAgent }) {
  const launched = isScreenAgent(agent) && (G1_AGENTS_SHIPPED || (LAUNCH_AGENTS as readonly string[]).includes(agent));
  if (!isScreenAgent(agent) || !launched) return <ComingSoonPage agent={agent} />;
  return <ScreenAgentPage agent={agent} />;
}

function ComingSoonPage({ agent }: { agent: PageAgent }) {
  return (
    <>
      <AgentsTabs current="agent" />
      <h2 className={styles.title}>{AGENT_LABEL[agent]}</h2>
      <EmptyState title={agents.agentComingSoon} />
    </>
  );
}

function ScreenAgentPage({ agent }: { agent: ScreenAgent }) {
  const [period, setPeriod] = useState<TimePeriod>('month');
  const detail = useAgentDetail(agent, period);
  const me = useMe();
  const d = detail.data;

  return (
    <div className={styles.page}>
      <AgentsTabs current="agent" />
      <div className={styles.header}><h2 className={styles.title}>{AGENT_LABEL[agent]}</h2><PeriodPicker value={period} onChange={setPeriod} /></div>
      {detail.isPending ? (
        <div role="status" aria-label={agentPage.loading}>
          <Skeleton lines={4} />
        </div>
      ) : !d ? (
        <>
          <Banner tone="danger">{agentPage.loadError}</Banner>
          <div>
            <Button variant="ghost" onClick={() => void detail.refetch()}>
              {agentsCommon.retry}
            </Button>
          </div>
        </>
      ) : d.card.status === 'coming_soon' || d.runNow.kind === 'coming_soon' ? (
        <EmptyState title={agents.agentComingSoon} />
      ) : (
        <div className={`${styles.content} ${detail.isPlaceholderData ? styles.dim : ''}`} aria-busy={detail.isPlaceholderData}>
          {detail.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null}
          <p className={styles.saved}>
            <span>
              {agentPage.timeSaved} {hoursLabel(d.minutesInPeriod)} {agentsCommon.estimate}
            </span>
            {d.hourlyRateCents === null ? null : (
              <span className={styles.money}>
                {moneyLineText(d.minutesInPeriod, d.hourlyRateCents)} {agentsCommon.estimate}
                {me.data?.role === 'owner' ? (
                  <>
                    {' '}
                    <UiLink href={agentsCommon.changeRateHref}>{agentsCommon.changeRate}</UiLink>
                  </>
                ) : null}
              </span>
            )}
          </p>
          <div className={styles.layout} data-agent={agent}>
            <div className={styles.work}>
              {agent === 'claims' && <ClaimsBoard />}
              <TimeBreakdown rows={d.breakdown} />
              <RecentTasks tasks={d.recentTasks} />
            </div>
            <aside className={styles.sidebar}>
              <section className={styles.section}>
                <h3 className={styles.heading}>{agentPage.rulesTitle}</h3>
                <RulesList rules={d.rules} />
              </section>
              <PauseSwitch agent={agent} paused={d.paused} rules={d.rules} isOwner={me.data?.role === 'owner'} />
              {/* A paused Claims, Scheduler or Follow-up agent cannot run (the server answers 409), so it offers no Run now. */}
              {G1_SCREEN_AGENTS.includes(agent) && d.paused !== null ? null : <RunNowButton agent={agent} runNow={d.runNow} paused={d.paused !== null} />}
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}

/** The /agents/:agent route: a known agent gets its page in the Agents window, anything else the not-found window. */
export function AgentRoute() {
  const agent = agentFromSlug(useParams().agent);
  if (!agent) return <NotFoundWindow />;
  return (
    <AppWindow app="agents">
      <AgentPage agent={agent} />
    </AppWindow>
  );
}
