import { useId } from 'react';
import { Button, Card } from '@roofline/ui';
import type { CallView, ConversationDetail, ToolActionCard, TurnView } from '@roofline/shared';
import { conversationCopy } from '../../copy/front-desk-conversation.ts';
import { formatPhone } from '../../lib/phone.ts';
import styles from './ConversationView.module.css';

/** The record a tool action card links to. Claim intake has no route yet, so it is plain text. */
function actionHref(card: ToolActionCard): { href: string; text: string } | null {
  const link = card.link;
  if (!link) return null;
  switch (link.kind) {
    case 'customer':
      return { href: `/customers/${link.id}`, text: conversationCopy.linkCustomer };
    case 'job':
      return { href: `/jobs/${link.id}`, text: conversationCopy.linkJob };
    case 'appointment':
      return { href: `/calendar/appointments/${link.id}`, text: conversationCopy.linkAppointment };
    case 'claim_intake':
      return null;
  }
}

function ActionCard({ card }: { card: ToolActionCard }) {
  const target = actionHref(card);
  return (
    <Card as="li" className={styles.action} data-ok={card.ok ? 'true' : 'false'}>
      <p className={styles.actionLabel}>{card.label}</p>
      {card.ok ? null : <p className={styles.actionFailed}>{conversationCopy.actionFailed}</p>}
      {target ? (
        <div className={styles.actionLink}>
          <Button href={target.href} variant="ghost" size="md">
            {target.text}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function TurnBody({ turn, transcriptStored }: { turn: TurnView; transcriptStored: boolean }) {
  if (turn.text !== null) return <p className={styles.text}>{turn.text}</p>;
  return (
    <p className={styles.note}>
      {transcriptStored ? conversationCopy.transcriptRemoved : conversationCopy.transcriptNotKept}
    </p>
  );
}

/** Whether the call behind this turn kept its transcript. A text turn (no call) is judged by its own text. */
function turnTranscriptStored(turn: TurnView, calls: CallView[]): boolean {
  if (turn.callId === null) return true;
  const call = calls.find((c) => c.id === turn.callId);
  return call ? call.transcriptStored : true;
}

export function ConversationView({ conversation }: { conversation: ConversationDetail }) {
  const headingId = useId();
  // Time order; turns spoken at one instant keep their position order. A text's own line has position 0.
  const turns = [...conversation.turns].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.position - b.position);

  return (
    <article className={styles.view}>
      <header className={styles.header}>
        <h2 className={styles.name}>{conversation.customer?.name ?? conversationCopy.unknownCaller}</h2>
        <p className={styles.phone}>{formatPhone(conversation.phoneE164)}</p>
      </header>

      <section className={styles.transcript} aria-labelledby={headingId}>
        <h3 id={headingId} className={styles.heading}>
          {conversationCopy.transcriptHeading}
        </h3>
        {turns.length === 0 ? (
          <p className={styles.empty}>{conversationCopy.transcriptEmpty}</p>
        ) : (
          <ol className={styles.turns}>
            {turns.map((turn) => (
              <li key={turn.id} className={`${styles.turn} ${styles[turn.speaker]}`} data-speaker={turn.speaker}>
                <span className={styles.speaker}>{conversationCopy.speaker[turn.speaker]}</span>
                <TurnBody turn={turn} transcriptStored={turnTranscriptStored(turn, conversation.calls)} />
                {turn.truncated ? <span className={styles.truncated}>{conversationCopy.truncated}</span> : null}
                {turn.actions.length > 0 ? (
                  <ul className={styles.actions}>
                    {turn.actions.map((card, index) => (
                      <ActionCard key={`${turn.id}-${index}`} card={card} />
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}
