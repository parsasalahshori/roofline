import type { ConversationDetail, HandledBy } from '@roofline/shared';
import { Banner, Segmented } from '@roofline/ui';
import { conversationCopy } from '../../../copy/front-desk-conversation.ts';
import { useSetHandling } from '../conversation-api.ts';
import { timeOfDay } from '../format.ts';
import styles from './HandoffSwitch.module.css';

const copy = conversationCopy;

const OPTIONS = [
  { value: 'assistant', label: copy.handling.assistant },
  { value: 'team', label: copy.handling.team },
] as const satisfies ReadonlyArray<{ value: HandledBy; label: string }>;

/**
 * Who answers this conversation next: the assistant, or the team (which keeps the assistant quiet for two hours). A reply
 * from the team does not hand it over by itself; this switch does. While a change is on its way the choice already shows.
 */
export function HandoffSwitch({ conversation, zone }: { conversation: ConversationDetail; zone: string }) {
  const setHandling = useSetHandling(conversation.id);
  const shown = setHandling.isPending && setHandling.variables !== undefined ? setHandling.variables.by : conversation.handledBy;
  return (
    <div className={styles.handoff}>
      <div className={styles.row}>
        <span className={styles.eyebrow}>{copy.handlingTitle}</span>
        <Segmented<HandledBy>
          label={copy.handlingLabel}
          value={shown}
          options={OPTIONS}
          onChange={(by) => {
            if (!setHandling.isPending && by !== conversation.handledBy) setHandling.mutate({ by });
          }}
        />
        {conversation.handledBy === 'team' && conversation.teamUntil !== null ? (
          <span className={styles.until}>{copy.handlingUntil(timeOfDay(conversation.teamUntil, zone))}</span>
        ) : null}
      </div>
      {setHandling.isError ? <Banner tone="danger">{copy.handlingFailed}</Banner> : null}
    </div>
  );
}
