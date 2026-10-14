import { useEffect, useRef } from 'react';
import { useLocation, useParams } from 'react-router';
import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { CONVERSATION_FILTERS, type ConversationFilter } from '@roofline/shared';
import { FrontDeskLayout } from './FrontDeskWindow.tsx';
import { conversationCopy } from '../../copy/front-desk-conversation.ts';
import { ConversationView } from './ConversationView.tsx';
import { ReplyBox } from './ReplyBox.tsx';
import { SummaryPanel } from './SummaryPanel.tsx';
import { useConversation, useMarkRead } from './conversation-api.ts';
import styles from './ConversationWindow.module.css';

/** One conversation: the transcript, the summary and calls, and the reply box for text threads. */
export function ConversationWindow() {
  const { conversationId = '' } = useParams();
  const location = useLocation();
  // Only list navigation supplies context. Direct links do not fetch unrelated conversations.
  const state = location.state as { frontDeskFilter?: unknown } | null;
  const filter = state?.frontDeskFilter;
  const fromInbox = typeof filter === 'string' && (CONVERSATION_FILTERS as readonly string[]).includes(filter);
  const panel = <ConversationPanel key={conversationId} conversationId={conversationId} />;
  return fromInbox ? (
    <FrontDeskLayout selectedId={conversationId} initialFilter={filter as ConversationFilter}>
      {panel}
    </FrontDeskLayout>
  ) : panel;
}

function ConversationPanel({ conversationId }: { conversationId: string }) {
  const conversation = useConversation(conversationId);
  const markRead = useMarkRead(conversationId);
  const { mutate: markReadNow } = markRead;
  // The read receipt is sent once per conversation id, even when the effect runs twice (StrictMode).
  const markedId = useRef<string | null>(null);

  useEffect(() => {
    if (conversationId === '' || markedId.current === conversationId) return;
    markedId.current = conversationId;
    markReadNow();
  }, [conversationId, markReadNow]);

  if (conversation.isPending) {
    return (
      <div className={styles.window} role="status" aria-label={conversationCopy.loading}>
        <Skeleton lines={3} height="16px" />
      </div>
    );
  }

  if (conversation.isError || !conversation.data) {
    return (
      <EmptyState
        title={conversationCopy.loadFailed}
        action={<Button href="/front-desk" variant="ghost">{conversationCopy.backToInbox}</Button>}
      />
    );
  }

  const data = conversation.data;
  return (
    <div className={styles.window}>
      <div className={styles.navigation}>
        <Button href="/front-desk" variant="ghost">{conversationCopy.backToInbox}</Button>
      </div>
      <ConversationView conversation={data} overview={<SummaryPanel conversation={data} />} />
      {data.canReply ? <ReplyBox key={data.id} conversationId={data.id} /> : null}
    </div>
  );
}
