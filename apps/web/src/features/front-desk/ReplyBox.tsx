import { useState, type FormEvent } from 'react';
import { Button, Field } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { conversationCopy } from '../../copy/front-desk-conversation.ts';
import { useSendReply } from './conversation-api.ts';
import styles from './ReplyBox.module.css';

/**
 * The text reply box for a text conversation. A send-gate refusal comes back as an ApiError whose
 * message is the plain sentence to show; the typed text stays so the person can edit it.
 */
export function ReplyBox({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState('');
  const send = useSendReply(conversationId);
  const trimmed = text.trim();
  const errorSentence = send.error
    ? send.error instanceof ApiError
      ? send.error.message
      : conversationCopy.replyFailed
    : undefined;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed === '' || send.isPending) return;
    send.mutate(
      { body: trimmed },
      { onSuccess: () => setText('') },
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <Field
        label={conversationCopy.replyLabel}
        placeholder={conversationCopy.replyPlaceholder}
        multiline
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        error={errorSentence}
      />
      <div className={styles.actions}>
        <Button type="submit" busy={send.isPending} disabled={trimmed === ''}>
          {conversationCopy.replySend}
        </Button>
      </div>
    </form>
  );
}
