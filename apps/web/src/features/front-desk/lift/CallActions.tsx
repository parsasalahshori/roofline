import { Banner, Button, Pill, Toggle } from '@roofline/ui';
import type { ConversationDetail } from '@roofline/shared';
import { useMe } from '../../../api/hooks.ts';
import { conversationCopy } from '../../../copy/front-desk-conversation.ts';
import { useMarkSpam, useSetHandling } from '../conversation-api.ts';
import styles from './CallActions.module.css';

/**
 * What staff do with a conversation, under its header: hand it to the team (or back to the assistant), and for a
 * voice call Mark as spam (owner and office only, the roles the server lets mark spam) and Call back.
 */
export function CallActions({ conversation }: { conversation: ConversationDetail }) {
  const setHandling = useSetHandling(conversation.id);
  const markSpam = useMarkSpam(conversation.id);
  const lastCall = conversation.calls.at(-1) ?? null;
  const role = useMe().data?.role;
  const canMarkSpam = role === 'owner' || role === 'office';
  const isCall = conversation.channel === 'voice' && lastCall !== null;

  return (
    <div className={styles.actions}>
      <Toggle
        checked={conversation.handledBy === 'team'}
        label={conversationCopy.handling}
        disabled={setHandling.isPending}
        onChange={(next) => setHandling.mutate({ by: next ? 'team' : 'assistant' })}
      />
      <div className={styles.buttons}>
        {isCall && lastCall.spamReason !== null ? <Pill tone="neutral">{conversationCopy.spamMarked}</Pill> : null}
        {canMarkSpam && isCall && lastCall.spamReason === null ? (
          <Button variant="ghost" busy={markSpam.isPending} onClick={() => markSpam.mutate(lastCall.id)}>
            {conversationCopy.markSpam}
          </Button>
        ) : null}
        <Button variant="ghost" href={`tel:${conversation.phoneE164}`}>
          {conversationCopy.callBack}
        </Button>
      </div>
      {setHandling.isError ? <Banner tone="danger">{conversationCopy.handlingFailed}</Banner> : null}
      {markSpam.isError ? <Banner tone="danger">{conversationCopy.spamFailed}</Banner> : null}
    </div>
  );
}
