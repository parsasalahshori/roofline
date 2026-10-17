import { Fragment } from 'react';
import type { CallView, ConversationDetail, TurnView } from '@roofline/shared';
import { Icon, Panel, Tag } from '@roofline/ui';
import { conversationCopy } from '../../../copy/front-desk-conversation.ts';
import { dayKey, dayLabel, offsetLabel, timeOfDay } from '../format.ts';
import { ActionCard } from './ActionCard.tsx';
import styles from './TranscriptPanel.module.css';

const copy = conversationCopy;

/** Why a line has no words: the caller asked for no transcript, retention swept it, or it was a photo or an empty text. */
function turnNote(turn: TurnView, call: CallView | undefined): string {
  if (turn.noWords === true) return copy.noWords;
  return call !== undefined && !call.transcriptStored ? copy.transcriptNotKept : copy.transcriptRemoved;
}

/**
 * Where a line was said. A line spoken on a call is stamped with how far into the call it was (the clock the recording plays
 * on); a text is stamped with the time it arrived, on the company's own clock.
 */
function stampOf(turn: TurnView, call: CallView | undefined, zone: string): string {
  return call !== undefined ? offsetLabel(turn.at, call.startedAt) : timeOfDay(turn.at, zone);
}

function Turn({ turn, call, zone }: { turn: TurnView; call: CallView | undefined; zone: string }) {
  const speaker = copy.speaker[turn.speaker];
  const words = turn.text !== null ? turn.text : turnNote(turn, call);
  if (turn.speaker === 'system') {
    return (
      <li className={styles.system} data-speaker="system">
        <span className={styles.systemLabel}>{speaker}</span>
        <span>{words}</span>
      </li>
    );
  }
  const mine = turn.speaker !== 'caller';
  return (
    <li className={styles.turn} data-speaker={turn.speaker} data-side={mine ? 'right' : 'left'}>
      <div className={styles.bubble}>
        <p className={styles.label}>
          <span className={styles.speaker}>{speaker}</span>
          <time className={styles.stamp} dateTime={turn.at}>
            {stampOf(turn, call, zone)}
          </time>
        </p>
        <p className={turn.text !== null ? styles.text : styles.note}>{words}</p>
        {turn.truncated ? (
          <Tag icon="alert" className={styles.cut}>
            {copy.truncated}
          </Tag>
        ) : null}
      </div>
      {turn.actions.length > 0 ? (
        <ul className={styles.actions}>
          {turn.actions.map((card, index) => (
            <ActionCard key={`${turn.id}-${index}`} card={card} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * What was said, line by line in time order, the caller on the left and the assistant and the team on the right, with
 * the cards for what the assistant did under the line that did it. A thread of texts also marks where a new day starts.
 */
export function TranscriptPanel({ conversation, zone }: { conversation: ConversationDetail; zone: string }) {
  // Time order; lines spoken at one instant keep their position order. A text's own line has position 0.
  const turns = [...conversation.turns].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.position - b.position);
  // A new day starts only in a thread of texts: a call's lines are counted from its start
  const rows: { turn: TurnView; call: CallView | undefined; startsDay: boolean }[] = [];
  let lastDay: string | null = null;
  for (const turn of turns) {
    const call = turn.callId === null ? undefined : conversation.calls.find((candidate) => candidate.id === turn.callId);
    const day = call === undefined ? dayKey(turn.at, zone) : null;
    rows.push({ turn, call, startsDay: day !== null && day !== lastDay });
    if (day !== null) lastDay = day;
  }

  return (
    <Panel title={copy.transcriptHeading} headingLevel={3} tag={<span className={styles.count}>{copy.messageCount(turns.length)}</span>}>
      {turns.length === 0 ? (
        <p className={styles.empty}>{copy.transcriptEmpty}</p>
      ) : (
        <ol className={styles.turns}>
          {rows.map(({ turn, call, startsDay }) => (
            <Fragment key={turn.id}>
              {startsDay ? (
                <li className={styles.day}>
                  <Icon name="cal" size={16} />
                  {dayLabel(turn.at, zone)}
                </li>
              ) : null}
              <Turn turn={turn} call={call} zone={zone} />
            </Fragment>
          ))}
        </ol>
      )}
    </Panel>
  );
}
