import { useState, type KeyboardEvent } from 'react';
import type { PublicProposalView } from '@roofline/shared';
import { Banner, Button, Checkbox, Field, Sheet } from '@roofline/ui';
import { homeowner } from '../../copy/homeowner.ts';
import { useSignProposal, type SignBody } from './api.ts';
import { SignaturePad } from './SignaturePad.tsx';
import styles from './SignFlow.module.css';

export type SignFlowProps = {
  token: string;
  proposal: PublicProposalView;
  /** The chosen option's id (one of proposal.options). */
  optionId: string;
  open: boolean;
  onClose(): void;
  /** Called after the sign request succeeds. */
  onSigned(): void;
};

export function SignFlow({ token, proposal, optionId, open, onClose, onSigned }: SignFlowProps) {
  const option = proposal.options.find((candidate) => candidate.id === optionId);
  const sign = useSignProposal(token);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState<string | null>(null);
  // Errors show once a submit has been tried, then follow the fields as they change.
  const [attempted, setAttempted] = useState(false);

  const trimmedName = name.trim();
  const consentError = attempted && !consent ? homeowner.consentMissing : undefined;
  const nameError = attempted && trimmedName === '' ? homeowner.nameMissing : undefined;

  function submit() {
    if (sign.isPending) return;
    setAttempted(true);
    if (!option || !consent || trimmedName === '') return;
    const body: SignBody = { optionId, consent: true, signerName: trimmedName, typedSignature: trimmedName };
    if (drawn) body.drawnSignature = drawn;
    sign.mutate(body, { onSuccess: () => onSigned() });
  }

  // Enter in the name field submits, so the flow works from the keyboard alone.
  function onNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  }

  const footer = option ? (
    <Button type="button" className={styles.submit} busy={sign.isPending} onClick={submit}>
      {homeowner.signAndAccept(option.totalCents)}
    </Button>
  ) : undefined;

  return (
    <Sheet open={open} title={homeowner.signTitle} onClose={onClose} closeLabel={homeowner.closeLabel} footer={footer}>
      <div className={styles.body}>
        {option ? (
          <>
            <p className={styles.summary}>{homeowner.signSummary(option.name, option.totalCents)}</p>
            {proposal.estimateClause ? <p className={styles.clause}>{homeowner.estimateClause}</p> : null}
          </>
        ) : (
          <Banner tone="danger">{homeowner.optionMissing}</Banner>
        )}
        <Checkbox checked={consent} onChange={setConsent} label={homeowner.consentText} error={consentError} />
        <div className={styles.nameField}>
          <Field
            label={homeowner.nameLabel}
            help={homeowner.nameHelp}
            error={nameError}
            type="text"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onNameKeyDown}
          />
        </div>
        <section className={styles.draw}>
          <h3 className={styles.heading}>{homeowner.drawHeading}</h3>
          <SignaturePad onChange={setDrawn} disabled={sign.isPending} />
        </section>
        {sign.error ? <Banner tone="danger">{sign.error.message}</Banner> : null}
      </div>
    </Sheet>
  );
}
