import { useEffect, useState } from 'react';
import type { ConversationFilter } from '@roofline/shared';
import { Button, Chip, EmptyState, Icon, Panel, Skeleton } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { ConversationRow } from './ConversationRow.tsx';
import { flattenItems, useConversations, useDayStats } from './inbox-api.ts';
import styles from './InboxList.module.css';

const copy = frontDeskInbox;

/** The filters, in order, each asking the inbox for one list. */
export const TABS = ['all', 'booked', 'messages', 'spam'] as const satisfies readonly ConversationFilter[];
export type InboxTab = (typeof TABS)[number];

/** A clock that ticks once a minute, so "14 min ago" ages without a refetch. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Rows that wear the shape of the real ones, so a loading list and an empty one show what will be there. */
function GhostRows({ count, busy = false }: { count: number; busy?: boolean }) {
  return (
    <div className={styles.ghosts} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={styles.ghost} data-busy={busy ? 'true' : undefined}>
          {busy ? <Skeleton width="40px" height="40px" /> : <span className={styles.ghostAvatar} />}
          <span className={styles.ghostLines}>
            {busy ? <Skeleton width="45%" height="14px" /> : <span className={styles.ghostLine} data-wide="true" />}
            {busy ? <Skeleton width="70%" height="22px" /> : <span className={styles.ghostLine} />}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * "Latest calls": a panel with the four filters over the list of calls and texts. The filter the person chose is the
 * one the server is asked for; the counts on the chips are today's numbers, which a rep (who never asks) does not see.
 */
export function InboxList({ conversationId }: { conversationId: string | undefined }) {
  const [filter, setFilter] = useState<InboxTab>('all');
  const conversations = useConversations(filter);
  const now = useMinuteClock();
  const role = useMe().data?.role;
  const staff = role === 'owner' || role === 'office';
  // The server refuses a rep's request for today's numbers, so a rep never asks
  const counts = useDayStats(staff).data?.tabCounts;
  const items = flattenItems(conversations.data?.pages);

  let body;
  if (conversations.isPending) {
    body = <GhostRows count={6} busy />;
  } else if (items.length === 0 && conversations.isError) {
    body = (
      <div className={styles.error} role="alert">
        <Icon name="alert" size={18} />
        <p className={styles.errorText}>{copy.loadError}</p>
        <Button variant="default" size="sm" onClick={() => void conversations.refetch()}>
          {copy.tryAgain}
        </Button>
      </div>
    );
  } else if (items.length === 0 && filter === 'all') {
    body = (
      <div className={styles.empty}>
        <EmptyState
          title={copy.empty}
          body={copy.emptyHint}
          action={
            staff ? (
              <Button variant="default" href="/settings/front-desk#forwarding">
                {copy.forwardingSettings}
              </Button>
            ) : undefined
          }
        />
        <GhostRows count={3} />
      </div>
    );
  } else if (items.length === 0) {
    body = <EmptyState title={copy.filterEmpty} />;
  } else {
    body = (
      <>
        <ul className={styles.list}>
          {items.map((item) => (
            <ConversationRow key={item.id} item={item} selected={item.id === conversationId} now={now} />
          ))}
        </ul>
        {conversations.hasNextPage ? (
          <div className={styles.more}>
            <Button variant="ghost" busy={conversations.isFetchingNextPage} onClick={() => void conversations.fetchNextPage()}>
              {copy.loadMore}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <Panel title={copy.listTitle} tag={copy.listHint} padded={false} className={styles.panel}>
      <div className={styles.inner}>
        <div role="group" aria-label={copy.tabsLabel} className={styles.chips}>
          {TABS.map((tab) => (
            <Chip key={tab} pressed={tab === filter} count={counts?.[tab]} onClick={() => setFilter(tab)}>
              {copy.tabs[tab]}
            </Chip>
          ))}
        </div>
        <div className={styles.scroll}>{body}</div>
      </div>
    </Panel>
  );
}
