import { useState } from 'react';
import { LAUNCH_AGENTS, type ScreenAgent } from '@roofline/shared';
import { Banner, Button, Chip, EmptyState, Panel, Skeleton } from '@roofline/ui';
import { agents, agentsCommon } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { InlineError } from '../approvals/InlineError.tsx';
import { useCompany } from '../settings/api.ts';
import { AgentGlyph } from './AgentGlyph.tsx';
import { useAgentFeed } from './api.ts';
import { agentTimeLabel } from './time.ts';
import styles from './ActivityFeed.module.css';

/** What the agents did, newest first: one chip per launch agent filters it, 'Show more' loads older rows. */
export function ActivityFeed() {
  const [filter, setFilter] = useState<ScreenAgent | undefined>(undefined);
  const feed = useAgentFeed(filter);
  const zone = useCompany().data?.timezone;
  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <div role="group" aria-label={agents.feedFiltersLabel} className={styles.filters}>
        <Chip pressed={filter === undefined} onClick={() => setFilter(undefined)}>
          {agents.feedFilterAll}
        </Chip>
        {LAUNCH_AGENTS.map((agent) => (
          <Chip key={agent} pressed={filter === agent} onClick={() => setFilter(agent)}>
            {AGENT_LABEL[agent]}
          </Chip>
        ))}
      </div>
      {feed.isPending ? (
        <div className={styles.loading} role="status" aria-label={agents.feedLoading}>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className={styles.skeletonRow}>
              <Skeleton width="22px" height="22px" />
              <Skeleton width={index % 2 === 0 ? '60%' : '45%'} height="0.875rem" />
            </div>
          ))}
        </div>
      ) : !feed.data ? (
        <InlineError tag={agentsCommon.errorTag} message={agents.feedLoadError} retryLabel={agentsCommon.retry} onRetry={() => void feed.refetch()} />
      ) : items.length === 0 ? (
        <Panel as="div">
          <EmptyState title={agents.feedEmpty} />
        </Panel>
      ) : (
        <>
          {feed.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null}
          <Panel as="div" padded={false}>
            <ul aria-label={agents.feedListLabel} className={styles.list}>
              {items.map((item) => (
                <li key={item.id} className={styles.row}>
                  <AgentGlyph agent={item.agent} />
                  <div className={styles.text}>
                    <p className={styles.sentence}>{item.text}</p>
                    <p className={styles.meta}>
                      <span className={styles.agent}>{AGENT_LABEL[item.agent]}</span>
                      <time dateTime={item.at} className={styles.time}>
                        {agentTimeLabel(item.at, zone)}
                      </time>
                    </p>
                  </div>
                  {item.href ? (
                    <Button href={item.href} variant="default" size="sm" className={styles.open}>
                      {agents.feedOpen}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
          {feed.hasNextPage ? (
            <Button variant="default" className={styles.more} busy={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
              {agents.feedShowMore}
            </Button>
          ) : null}
        </>
      )}
    </>
  );
}
