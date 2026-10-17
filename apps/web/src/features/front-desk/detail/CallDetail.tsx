import { useId } from 'react';
import type { ConversationDetail } from '@roofline/shared';
import { Button, Icon, Skeleton } from '@roofline/ui';
import { conversationCopy } from '../../../copy/front-desk-conversation.ts';
import { useCompany } from '../../settings/api.ts';
import { browserZone } from '../../calendar/time.ts';
import { useConversation } from '../conversation-api.ts';
import { ReplyBox } from '../ReplyBox.tsx';
import { DetailHeader } from './DetailHeader.tsx';
import { HandoffSwitch } from './HandoffSwitch.tsx';
import { hasRecording, RecordingPanel } from './RecordingPanel.tsx';
import { SummaryPanel } from './SummaryPanel.tsx';
import { TranscriptPanel } from './TranscriptPanel.tsx';
import styles from './CallDetail.module.css';

const copy = conversationCopy;

/** The open conversation: who, who is handling it, the summary, the recording, the transcript, and for a text the reply box pinned under it. */
function Detail({ conversation }: { conversation: ConversationDetail }) {
  const nameId = useId();
  const zone = useCompany().data?.timezone ?? browserZone();
  const lastCall = conversation.calls.at(-1) ?? null;
  const recordable = conversation.channel === 'voice' && lastCall !== null && hasRecording(lastCall);

  return (
    <article className={styles.detail} aria-labelledby={nameId}>
      <div className={styles.scroll}>
        <DetailHeader conversation={conversation} zone={zone} nameId={nameId} />
        <HandoffSwitch conversation={conversation} zone={zone} />
        <SummaryPanel conversation={conversation} />
        {recordable ? <RecordingPanel key={lastCall.id} call={lastCall} /> : null}
        <TranscriptPanel conversation={conversation} zone={zone} />
      </div>
      {conversation.canReply ? (
        <div className={styles.reply}>
          <ReplyBox conversationId={conversation.id} />
        </div>
      ) : null}
    </article>
  );
}

/** Rows that wear the shape of the open call, so what is loading shows where it will land. */
function DetailSkeleton() {
  return (
    <div className={styles.detail} role="status" aria-label={copy.loading} aria-busy="true">
      <div className={styles.scroll}>
        <div className={styles.skeletonHead}>
          <Skeleton width="40px" height="40px" />
          <div className={styles.skeletonLines}>
            <Skeleton width="40%" height="24px" />
            <Skeleton width="25%" height="22px" />
          </div>
        </div>
        <div className={styles.skeletonPanel}>
          <Skeleton width="30%" height="16px" />
          <Skeleton lines={2} height="14px" />
        </div>
        <div className={styles.skeletonPanel}>
          <Skeleton width="30%" height="16px" />
          <Skeleton lines={5} height="44px" />
        </div>
      </div>
    </div>
  );
}

/** The right side of the Front Desk page: the call that was picked, loading, failed, or in full. */
export function CallDetail({ conversationId }: { conversationId: string }) {
  const conversation = useConversation(conversationId);

  if (conversation.isPending) return <DetailSkeleton />;
  if (conversation.isError || !conversation.data) {
    return (
      <div className={styles.error} role="alert">
        <Icon name="alert" size={18} />
        <p className={styles.errorText}>{copy.loadFailed}</p>
        <Button variant="default" size="sm" onClick={() => void conversation.refetch()}>
          {copy.tryAgain}
        </Button>
      </div>
    );
  }
  return <Detail conversation={conversation.data} />;
}
