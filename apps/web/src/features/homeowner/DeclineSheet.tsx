import { useState } from 'react';
import { Banner, Button, Field, Sheet } from '@roofline/ui';
import { homeowner } from '../../copy/homeowner.ts';
import { useDeclineProposal, type DeclineBody } from './api.ts';
import styles from './DeclineSheet.module.css';

export type DeclineSheetProps = {
  token: string;
  open: boolean;
  onClose(): void;
  /** Called after the decline request succeeds. */
  onDeclined(): void;
};

export function DeclineSheet({ token, open, onClose, onDeclined }: DeclineSheetProps) {
  const decline = useDeclineProposal(token);
  const [reason, setReason] = useState('');

  function send() {
    if (decline.isPending) return;
    const trimmed = reason.trim();
    const body: DeclineBody = trimmed === '' ? {} : { reason: trimmed };
    decline.mutate(body, { onSuccess: () => onDeclined() });
  }

  const footer = (
    <>
      <Button type="button" variant="danger" className={styles.action} busy={decline.isPending} onClick={send}>
        {homeowner.declineSend}
      </Button>
      <Button type="button" variant="ghost" className={styles.action} onClick={onClose}>
        {homeowner.declineKeep}
      </Button>
    </>
  );

  return (
    <Sheet open={open} title={homeowner.declineTitle} onClose={onClose} closeLabel={homeowner.closeLabel} footer={footer}>
      <div className={styles.body}>
        <p className={styles.intro}>{homeowner.declineIntro}</p>
        <div className={styles.reason}>
          <Field
            label={homeowner.declineReasonLabel}
            multiline
            rows={4}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {decline.error ? <Banner tone="danger">{decline.error.message}</Banner> : null}
      </div>
    </Sheet>
  );
}
