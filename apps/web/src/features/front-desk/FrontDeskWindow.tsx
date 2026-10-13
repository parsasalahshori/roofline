import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type { ConversationFilter } from '@roofline/shared';
import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { ConversationRow } from './ConversationRow.tsx';
import { useMarkReadOnOpen } from './conversation-api.ts';
import { flattenItems, useConversations, useDayStats } from './inbox-api.ts';
import { CallDetail } from './lift/CallDetail.tsx';
import { KpiTiles } from './lift/KpiTiles.tsx';
import styles from './FrontDeskWindow.module.css';

const copy = frontDeskInbox.lift;

/** The tabs, in order, each asking the inbox for one filter. */
const TABS = ['all', 'booked', 'messages', 'spam'] as const satisfies readonly ConversationFilter[];

/**
 * Front Desk: today's numbers (owner and office) under the window's own title bar, over "Latest calls" on the left and the selected call on the right.
 * `/front-desk/:conversationId` selects a call; on a phone the list and the call take turns (the CSS keys off `data-detail`).
 */
export function FrontDeskWindow() {
  const { conversationId } = useParams();
  useMarkReadOnOpen(conversationId ?? '');
  const [filter, setFilter] = useState<(typeof TABS)[number]>('all');
  const conversations = useConversations(filter);
  // Today's numbers are for the owner and the office (the server refuses a rep), so a rep never asks.
  const role = useMe().data?.role;
  const showStats = role === 'owner' || role === 'office';
  const items = flattenItems(conversations.data?.pages);
  // "14 min ago" counts from a clock that ticks once a minute, so the rows age without a refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  let list;
  if (conversations.isPending) {
    list = <Skeleton lines={3} height="56px" />;
  } else if (items.length === 0 && conversations.isError) {
    list = <p className={styles.note}>{frontDeskInbox.loadError}</p>;
  } else if (items.length === 0) {
    list = <EmptyState title={filter === 'all' ? frontDeskInbox.empty : frontDeskInbox.filterEmpty} />;
  } else {
    list = (
      <>
        <ul className={styles.list}>
          {items.map((item) => (
            <ConversationRow key={item.id} item={item} selected={item.id === conversationId} now={now} />
          ))}
        </ul>
        {conversations.hasNextPage ? (
          <Button
            variant="ghost"
            className={styles.more}
            busy={conversations.isFetchingNextPage}
            onClick={() => void conversations.fetchNextPage()}
          >
            {frontDeskInbox.loadMore}
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <div className={styles.root} data-detail={conversationId === undefined ? 'closed' : 'open'}>
      {showStats ? (
        <div className={styles.tiles}>
          <KpiTiles />
        </div>
      ) : null}
      <div className={styles.split}>
        <section className={styles.listPane} aria-label={copy.listTitle}>
          <div className={styles.listHeader}>
            <h3 className={styles.listTitle}>{copy.listTitle}</h3>
            <span className={styles.listHint}>{copy.listHint}</span>
          </div>
          <Tabs filter={filter} onChange={setFilter} />
          {list}
        </section>
        <section className={styles.detailPane} aria-label={frontDeskInbox.lift.title}>
          {conversationId === undefined ? null : (
            <Button href="/front-desk" variant="ghost" className={styles.back}>
              {copy.backToCalls}
            </Button>
          )}
          {conversationId === undefined ? (
            <p className={styles.pick}>{copy.pickCall}</p>
          ) : (
            <CallDetail key={conversationId} conversationId={conversationId} />
          )}
        </section>
      </div>
    </div>
  );
}

/** All / Booked / Text-backs / Blocked. The counts come from today's numbers, so a rep (who never asks) sees the names alone. */
function Tabs({ filter, onChange }: { filter: (typeof TABS)[number]; onChange: (next: (typeof TABS)[number]) => void }) {
  const counts = useDayStatsCounts();
  return (
    <div role="group" aria-label={copy.tabsLabel} className={styles.tabs}>
      {TABS.map((tab) => {
        const selected = tab === filter;
        const count = counts?.[tab];
        return (
          <Button key={tab} variant="ghost" size="md" className={styles.tab} aria-pressed={selected} onClick={() => onChange(tab)}>
            {copy.tabs[tab]}
            {count === undefined ? null : <span className={styles.count}>{count}</span>}
          </Button>
        );
      })}
    </div>
  );
}

function useDayStatsCounts() {
  const role = useMe().data?.role;
  const allowed = role === 'owner' || role === 'office';
  // A rep is refused by the server, so a rep never asks.
  const { data } = useDayStats(allowed);
  return allowed ? data?.tabCounts : undefined;
}
