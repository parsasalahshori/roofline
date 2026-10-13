import { useEffect, useState } from 'react';
import { Card, Skeleton } from '@roofline/ui';
import { useTasksSummary } from '../../../api/hooks.ts';
import { liftFeed } from '../../../copy/liftFeed.ts';
import { AGENT_LABEL } from '../../../copy/status.ts';
import { useAgentFeed } from '../../agents/api.ts';
import styles from './AiFeedCard.module.css';

/** How many of the latest agent actions the card lists. */
const ROWS = 6;
/** The relative times are redrawn this often. */
const TICK_MS = 60_000;

/** What the agents did lately, newest first, with how many are working now. Reads the Agents screen's feed. */
export function AiFeedCard() {
  const feed = useAgentFeed();
  const summary = useTasksSummary();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const items = (feed.data?.pages[0]?.items ?? []).slice(0, ROWS);
  const working = summary.data?.working ?? 0;

  return (
    <Card as="section" className={styles.card} aria-labelledby="lift-ai-feed">
      <div className={styles.head}>
        <h2 id="lift-ai-feed" className={styles.title}>
          {liftFeed.feedTitle}
        </h2>
        {working > 0 ? <span className={styles.chip}>{liftFeed.working(working)}</span> : null}
      </div>
      {feed.isPending ? (
        <div role="status" aria-label={liftFeed.feedLoading}>
          <Skeleton lines={4} height="2.5rem" />
        </div>
      ) : !feed.data ? (
        <p className={styles.empty}>{liftFeed.feedLoadError}</p>
      ) : items.length === 0 ? (
        <p className={styles.empty}>{liftFeed.feedEmpty}</p>
      ) : (
        <ul className={styles.list} aria-label={liftFeed.feedListLabel}>
          {items.map((item) => (
            <li key={item.id} className={styles.row} data-agent={item.agent}>
              <span className={styles.dot} aria-hidden="true" />
              <div className={styles.body}>
                <span className={styles.text}>{item.text}</span>
                <span className={styles.byline}>{liftFeed.byline(AGENT_LABEL[item.agent], liftFeed.ago(item.at, now))}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
