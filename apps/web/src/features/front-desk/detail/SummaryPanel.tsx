import { useId } from 'react';
import type { ConversationDetail } from '@roofline/shared';
import { Panel } from '@roofline/ui';
import { conversationCopy } from '../../../copy/front-desk-conversation.ts';
import styles from './SummaryPanel.module.css';

const copy = conversationCopy;

/**
 * What the call came to, in the assistant's own words, and what is left to do. A call always has the panel (until its
 * summary is written it says so); a text thread has one only when there is something to say.
 */
export function SummaryPanel({ conversation }: { conversation: ConversationDetail }) {
  const todoId = useId();
  const hasFollowUps = conversation.followUps.length > 0;
  if (conversation.channel === 'sms' && !conversation.summary && !hasFollowUps) return null;
  return (
    <Panel title={copy.summaryHeading} headingLevel={3} tag={copy.summaryBy}>
      <p className={styles.summary} data-empty={conversation.summary ? undefined : 'true'}>
        {conversation.summary ? conversation.summary : copy.summaryNone}
      </p>
      {hasFollowUps ? (
        <div className={styles.todo}>
          <p id={todoId} className={styles.eyebrow}>
            {copy.followUpsHeading}
          </p>
          <ul className={styles.list} aria-labelledby={todoId}>
            {conversation.followUps.map((item) => (
              <li key={item} className={styles.item}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}
