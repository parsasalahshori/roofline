import { Banner, Button, Card, Pill, Toggle } from '@roofline/ui';
import type { ConversationDetail } from '@roofline/shared';
import { useMe } from '../../api/hooks.ts';
import { conversationCopy } from '../../copy/front-desk-conversation.ts';
import { useMarkSpam, useSetHandling } from './conversation-api.ts';
import { RecordingPlayer } from './RecordingPlayer.tsx';
import styles from './SummaryPanel.module.css';

/**
 * The summary card beside the transcript: the summary and follow-ups, the recordings, who is
 * handling the conversation, and for a voice call, Mark as spam (owner and office only, the roles the
 * server lets mark spam) and Call back.
 */
export function SummaryPanel({ conversation }: { conversation: ConversationDetail }) {
  const setHandling = useSetHandling(conversation.id);
  const markSpam = useMarkSpam(conversation.id);
  const lastCall = conversation.calls.at(-1) ?? null;
  const role = useMe().data?.role;
  const canMarkSpam = role === 'owner' || role === 'office';
  const showSpam = conversation.channel === 'voice' && lastCall !== null;

  return (
    <Card as="section" className={styles.panel}>
      <h2 className={styles.heading}>{conversationCopy.summaryHeading}</h2>
      <p className={styles.text}>{conversation.summary ? conversation.summary : conversationCopy.summaryNone}</p>

      {conversation.followUps.length > 0 ? (
        <div className={styles.block}>
          <h3 className={styles.subheading}>{conversationCopy.followUpsHeading}</h3>
          <ul className={styles.list}>
            {conversation.followUps.map((item) => (
              <li key={item} className={styles.text}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.block}>
        <Toggle
          checked={conversation.handledBy === 'team'}
          label={conversationCopy.handling}
          disabled={setHandling.isPending}
          onChange={(next) => setHandling.mutate({ by: next ? 'team' : 'assistant' })}
        />
        {setHandling.isError ? <Banner tone="danger">{conversationCopy.handlingFailed}</Banner> : null}
      </div>

      {conversation.calls.map((call) => (
        <RecordingPlayer key={call.id} call={call} />
      ))}

      <div className={styles.actions}>
        {showSpam && lastCall !== null && lastCall.spamReason !== null ? (
          <Pill tone="neutral">{conversationCopy.spamMarked}</Pill>
        ) : null}
        {canMarkSpam && showSpam && lastCall !== null && lastCall.spamReason === null ? (
          <Button variant="ghost" busy={markSpam.isPending} onClick={() => markSpam.mutate(lastCall.id)}>
            {conversationCopy.markSpam}
          </Button>
        ) : null}
        <Button variant="ghost" href={`tel:${conversation.phoneE164}`}>
          {conversationCopy.callBack}
        </Button>
      </div>
      {markSpam.isError ? <Banner tone="danger">{conversationCopy.spamFailed}</Banner> : null}
    </Card>
  );
}
