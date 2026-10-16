import { useState, type FormEvent } from 'react';
import { Button, Field, Icon } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { conversationCopy } from '../../copy/front-desk-conversation.ts';
import { browserZone } from '../calendar/time.ts';
import { useCompany } from '../settings/api.ts';
import { useSendReply } from './conversation-api.ts';
import styles from './ReplyBox.module.css';

const scheduledFormats = new Map<string, Intl.DateTimeFormat>();

/** "Thu 8:00 AM" on the company's own clock, which is the clock quiet hours are kept on. */
function scheduledLabel(iso: string, zone: string): string {
  let format = scheduledFormats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    scheduledFormats.set(zone, format);
  }
  return format.format(new Date(iso)).replace(/[\u00a0\u202f]/g, ' ');
}

/**
 * The text reply box for a text conversation. A send-gate refusal (or a text that could not be sent)
 * comes back as an ApiError whose message is the plain sentence to show; the typed text stays so the
 * person can edit it. A reply held for quiet hours clears the box and says when it will go out.
 */
export function ReplyBox({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState('');
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const send = useSendReply(conversationId);
  const zone = useCompany().data?.timezone ?? browserZone();
  const trimmed = text.trim();
  const errorSentence = send.error
    ? send.error instanceof ApiError
      ? send.error.message
      : conversationCopy.replyFailed
    : undefined;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed === '' || send.isPending) return;
    setScheduledFor(null);
    send.mutate(
      { body: trimmed },
      {
        onSuccess: (result) => {
          setText('');
          setScheduledFor(result.status === 'scheduled' ? result.scheduledFor : null);
        },
      },
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.composer}>
        <Field
          label={conversationCopy.replyLabel}
          labelHidden
          placeholder={conversationCopy.replyPlaceholder}
          multiline
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          error={errorSentence}
          className={styles.field}
        />
        <Button type="submit" busy={send.isPending} disabled={trimmed === ''} className={styles.send}>
          {conversationCopy.replySend}
          <Icon name="arrow" size={16} />
        </Button>
      </div>
      {scheduledFor !== null ? (
        <p className={styles.note} role="status">
          <Icon name="clock" size={16} />
          {conversationCopy.replyScheduled(scheduledLabel(scheduledFor, zone))}
        </p>
      ) : null}
    </form>
  );
}
