import { Button, Icon, Panel, Skeleton, Tag, UiLink } from '@roofline/ui';
import { useTasksSummary } from '../../../api/hooks.ts';
import { liftFeed } from '../../../copy/liftFeed.ts';
import { AGENT_LABEL } from '../../../copy/status.ts';
import { AGENT_ICON } from '../../../shell/agentIcon.ts';
import { useAgentFeed } from '../../agents/api.ts';
import { useNow } from '../useNow.ts';
import styles from './AiFeedCard.module.css';

/** How many of the latest agent actions the card lists. */
const ROWS = 6;
/** The rows that did not go to plan wear a flag (a word, not just a colour). */
const FLAGS: Record<string, string> = { expired: liftFeed.flagExpired, step_failed: liftFeed.flagLook, step_attention: liftFeed.flagLook };

/** What the agents did lately, newest first, with how many are working now. Reads the Agents screen's feed. */
export function AiFeedCard() {
  const feed = useAgentFeed();
  const summary = useTasksSummary();
  // The relative times are redrawn every minute
  const now = useNow();

  const items = (feed.data?.pages[0]?.items ?? []).slice(0, ROWS);
  const working = summary.data?.working ?? 0;

  return (
    <Panel
      title={liftFeed.feedTitle}
      tag={
        working > 0 ? (
          <Tag tone="info" icon="bolt">
            {liftFeed.working(working)}
          </Tag>
        ) : undefined
      }
      actions={
        <Button size="sm" variant="ghost" href="/agents">
          {liftFeed.agentsLink}
          <Icon name="chev" size={16} />
        </Button>
      }
      padded={false}
      className={styles.panel}
    >
      {feed.isPending ? (
        <div role="status" aria-label={liftFeed.feedLoading} className={styles.loading}>
          <Skeleton lines={4} height="2.5rem" />
        </div>
      ) : !feed.data ? (
        <p className={styles.empty}>{liftFeed.feedLoadError}</p>
      ) : items.length === 0 ? (
        <p className={styles.empty}>{liftFeed.feedEmpty}</p>
      ) : (
        <ul className={styles.list} aria-label={liftFeed.feedListLabel}>
          {items.map((item) => {
            const flag = FLAGS[item.kind];
            const body = (
              <>
                <span className={styles.glyph} aria-hidden="true">
                  <Icon name={AGENT_ICON[item.agent]} size={16} />
                </span>
                <span className={styles.body}>
                  <span className={styles.text}>{item.text}</span>
                  <span className={styles.byline}>
                    {liftFeed.byline(AGENT_LABEL[item.agent], liftFeed.ago(item.at, now))}
                    {flag ? (
                      <Tag tone="warn" icon="alert" className={styles.flag}>
                        {flag}
                      </Tag>
                    ) : null}
                  </span>
                </span>
              </>
            );
            return (
              <li key={item.id} data-agent={item.agent} className={styles.item}>
                {item.href !== null ? (
                  <UiLink href={item.href} className={styles.row}>
                    {body}
                  </UiLink>
                ) : (
                  <div className={styles.row}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
