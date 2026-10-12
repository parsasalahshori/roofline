import { hoursLabel, isScreenAgent, moneyLabel, type ScreenAgent, type TimePeriod } from '@roofline/shared';
import { Banner, EmptyState, Skeleton } from '@roofline/ui';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { agentPage, agents, agentsCommon } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AppWindow } from '../../shell/AppWindow.tsx';
import { NotFoundWindow } from '../../shell/NotFoundWindow.tsx';
import styles from './AgentPage.module.css';
import { useAgentDetail } from './api.ts';
import { AgentsTabs } from './AgentsTabs.tsx';
import { PauseSwitch } from './PauseSwitch.tsx';
import { PeriodPicker } from './PeriodPicker.tsx';
import { RecentTasks } from './RecentTasks.tsx';
import { RulesList } from './RulesList.tsx';
import { RunNowButton } from './RunNowButton.tsx';
import { TimeBreakdown } from './TimeBreakdown.tsx';
import { agentFromSlug, type PageAgent } from './slugs.ts';

/** One agent's page: time saved, what it does, pause and run controls, and its recent work. */
export function AgentPage({ agent }: { agent: PageAgent }) {
  if (!isScreenAgent(agent)) {
    return (
      <>
        <AgentsTabs current="agent" />
        <EmptyState title={AGENT_LABEL[agent]} body={agents.agentComingSoon} />
      </>
    );
  }
  return <ScreenAgentPage agent={agent} />;
}

function ScreenAgentPage({ agent }: { agent: ScreenAgent }) {
  const [period, setPeriod] = useState<TimePeriod>('month');
  const detail = useAgentDetail(agent, period);
  const me = useMe();
  const d = detail.data;

  return (
    <div className={styles.page}>
      <AgentsTabs current="agent" />
      <h2 className={styles.title}>{AGENT_LABEL[agent]}</h2>
      <PeriodPicker value={period} onChange={setPeriod} />
      {detail.isPending ? (
        <div role="status" aria-label={agentPage.loading}>
          <Skeleton lines={4} />
        </div>
      ) : detail.isError || !d ? (
        <Banner tone="danger">{agentPage.loadError}</Banner>
      ) : (
        <>
          <p className={styles.saved}>
            <span>
              {agentPage.timeSaved} {hoursLabel(d.minutesInPeriod)} {agentsCommon.estimate}
            </span>
            <span className={styles.money}>
              {moneyLabel(d.minutesInPeriod, d.hourlyRateCents)} {agentsCommon.estimate}
            </span>
          </p>
          <TimeBreakdown rows={d.breakdown} />
          <section className={styles.section}>
            <h3 className={styles.heading}>{agentPage.rulesTitle}</h3>
            <RulesList rules={d.rules} />
          </section>
          <PauseSwitch agent={agent} paused={d.paused} isOwner={me.data?.role === 'owner'} />
          <RunNowButton agent={agent} runNow={d.runNow} />
          <RecentTasks tasks={d.recentTasks} />
        </>
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
