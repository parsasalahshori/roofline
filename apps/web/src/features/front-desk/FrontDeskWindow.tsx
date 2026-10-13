import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { CONVERSATION_FILTERS, type ConversationFilter } from '@roofline/shared';
import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { useCompany } from '../settings/api.ts';
import { ConversationRow } from './ConversationRow.tsx';
import { flattenItems, useConversations } from './inbox-api.ts';
import styles from './FrontDeskWindow.module.css';
import { WeekStats } from './WeekStats.tsx';

/** Front Desk: this week's numbers (owner and office), then the calls and texts, filtered, with live calls on top of their rows. */
export function FrontDeskWindow() {
  return <FrontDeskLayout />;
}

/** Shared presentation for the inbox and a conversation opened from it. No automatic read receipt. */
export function FrontDeskLayout({
  children,
  selectedId,
  initialFilter = 'all',
}: {
  children?: ReactNode;
  selectedId?: string;
  initialFilter?: ConversationFilter;
}) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ConversationFilter>(initialFilter);
  const conversations = useConversations(filter);
  const timeZone = useCompany().data?.timezone;
  // The week's numbers are for the owner and the office (the server refuses a rep), so a rep never asks.
  const role = useMe().data?.role;
  const showStats = role === 'owner' || role === 'office';
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
            <ConversationRow
              key={item.id}
              item={item}
              timeZone={timeZone}
              selected={item.id === selectedId}
              onOpen={() => void navigate(`/front-desk/${item.id}`, { state: { frontDeskFilter: filter } })}
            />
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
    <div className={styles.root} data-conversation={selectedId ? 'true' : undefined}>
      {showStats ? <WeekStats /> : null}
      <div className={styles.workspace}>
        <section className={styles.inbox} aria-label={frontDeskInbox.inboxTitle}>
          <header className={styles.inboxHeader}>
            <h2>{frontDeskInbox.inboxTitle}</h2>
            <span>{frontDeskInbox.inboxDescription}</span>
          </header>
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
          <div className={styles.rows}>{content}</div>
          {conversations.isError && items.length > 0 ? (
            <p className={styles.note} role="status">{frontDeskInbox.refreshError}</p>
          ) : null}
        </section>
        <section className={styles.detail} aria-label={frontDeskInbox.conversationLabel}>
          {children ?? (
            <div className={styles.welcome}>
              <span className={styles.welcomeIcon} aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" focusable="false">
                  <path d="M4 4h16v12H9l-5 4V4Zm4 4h8M8 12h6" />
                </svg>
              </span>
              <h2>{frontDeskInbox.selectTitle}</h2>
              <p>{frontDeskInbox.selectHelp}</p>
              <p className={styles.selectionNote}>{frontDeskInbox.selectReadNote}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
