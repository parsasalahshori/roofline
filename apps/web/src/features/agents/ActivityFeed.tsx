import { useState } from 'react';
import { LAUNCH_AGENTS, type ScreenAgent } from '@roofline/shared';
import { Banner, Button, EmptyState, Skeleton } from '@roofline/ui';
import { agents, agentsCommon } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { useCompany } from '../settings/api.ts';
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
        <Button
          variant={filter === undefined ? 'primary' : 'ghost'}
          aria-pressed={filter === undefined}
          className={styles.chip}
          onClick={() => setFilter(undefined)}
        >
          {agents.feedFilterAll}
        </Button>
        {LAUNCH_AGENTS.map((agent) => (
          <Button
            key={agent}
            variant={filter === agent ? 'primary' : 'ghost'}
            aria-pressed={filter === agent}
            className={styles.chip}
            onClick={() => setFilter(agent)}
          >
            {AGENT_LABEL[agent]}
          </Button>
        ))}
      </div>
      {feed.isPending ? (
        <div role="status" aria-label={agents.feedLoading}>
          <Skeleton lines={4} height="2.5rem" />
        </div>
      ) : !feed.data ? (
        <EmptyState
          title={agents.feedLoadError}
          action={<Button onClick={() => void feed.refetch()}>{agentsCommon.retry}</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState title={agents.feedEmpty} />
      ) : (
        <>
          {feed.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null}
          <ul aria-label={agents.feedListLabel} className={styles.list}>
            {items.map((item) => (
              <li key={item.id} className={styles.row}>
                <span className={styles.agent}>{AGENT_LABEL[item.agent]}</span>
                <time dateTime={item.at} className={styles.time}>
                  {agentTimeLabel(item.at, zone)}
                </time>
                <span className={styles.text}>{item.text}</span>
                {item.href ? (
                  <Button href={item.href} variant="ghost" className={styles.open}>
                    {agents.feedOpen}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {feed.hasNextPage ? (
            <Button
              variant="ghost"
              className={styles.more}
              busy={feed.isFetchingNextPage}
              onClick={() => void feed.fetchNextPage()}
            >
              {agents.feedShowMore}
            </Button>
          ) : null}
        </>
      )}
    </>
  );
}
