import { useEffect, useRef } from 'react';
import { EmptyState, Skeleton } from '@roofline/ui';
import { conversationCopy } from '../../../copy/front-desk-conversation.ts';
import { ConversationView } from '../ConversationView.tsx';
import { ReplyBox } from '../ReplyBox.tsx';
import { SummaryPanel } from '../SummaryPanel.tsx';
import { useConversation, useMarkRead } from '../conversation-api.ts';
import styles from '../ConversationWindow.module.css';

/**
 * The call detail on the right of the Front Desk window. STUB (piece 8): it shows the existing conversation view, summary and
 * reply box for the id. Piece 9 replaces this file with the lifted detail; keep the `{ conversationId }` props.
 */
export function CallDetail({ conversationId }: { conversationId: string }) {
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
    return <EmptyState title={conversationCopy.loadFailed} />;
  }

  const data = conversation.data;
  return (
    <div className={styles.window}>
      <ConversationView conversation={data} />
      <SummaryPanel conversation={data} />
      {data.canReply ? <ReplyBox conversationId={data.id} /> : null}
    </div>
  );
}
