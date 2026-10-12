import { useState } from 'react';
import { CONVERSATION_FILTERS, type ConversationFilter } from '@roofline/shared';
import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { useCompany } from '../settings/api.ts';
import { ConversationRow } from './ConversationRow.tsx';
import { flattenItems, useConversations } from './inbox-api.ts';
import styles from './FrontDeskWindow.module.css';
import { WeekStats } from './WeekStats.tsx';

/** Front Desk: this week's numbers, then the calls and texts, filtered, with live calls on top of their rows. */
export function FrontDeskWindow() {
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const conversations = useConversations(filter);
  const timeZone = useCompany().data?.timezone;
  const items = flattenItems(conversations.data?.pages);

  let content;
  if (conversations.isPending) {
    content = <Skeleton lines={3} height="56px" />;
  } else if (items.length === 0 && conversations.isError) {
    content = <p className={styles.note}>{frontDeskInbox.loadError}</p>;
  } else if (items.length === 0) {
    content = <EmptyState title={filter === 'all' ? frontDeskInbox.empty : frontDeskInbox.filterEmpty} />;
  } else {
    content = (
      <>
        <ul className={styles.list}>
          {items.map((item) => (
            <ConversationRow key={item.id} item={item} timeZone={timeZone} />
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
    <div className={styles.root}>
      <WeekStats />
      <div role="group" aria-label={frontDeskInbox.filtersLabel} className={styles.filters}>
        {CONVERSATION_FILTERS.map((option) => {
          const selected = option === filter;
          return (
            <Button
              key={option}
              variant={selected ? 'primary' : 'ghost'}
              size="md"
              aria-pressed={selected}
              onClick={() => setFilter(option)}
            >
              {frontDeskInbox.filters[option]}
            </Button>
          );
        })}
      </div>
      {content}
    </div>
  );
}
