import { useState, type KeyboardEvent } from 'react';
import type { PublicProposalView } from '@roofline/shared';
import { Banner, Button, Checkbox, Field, Sheet } from '@roofline/ui';
import { homeowner, money } from '../../copy/homeowner.ts';
import { CheckIcon, PenIcon } from '../public/icons.tsx';
import { useSignProposal, type SignBody } from './api.ts';
import { addressText, financingOf, productLine } from './facts.ts';
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

/**
 * Signing, in a sheet: what is being signed, how it would be paid, the name, the optional drawing, and the one consent.
 * The consent's words are the versioned legal text; "financing is a separate approval" is said beside it, not in it.
 */
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
  const financing = option ? financingOf(option) : null;

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
    <Button type="button" size="lg" className={styles.submit} busy={sign.isPending} onClick={submit}>
      <PenIcon size={18} />
      {homeowner.signAndAccept(option.totalCents)}
    </Button>
  ) : undefined;

  return (
    <Sheet open={open} title={homeowner.signTitle} onClose={onClose} closeLabel={homeowner.closeLabel} footer={footer}>
      <div className={styles.body}>
        <ol className={styles.steps} aria-label={homeowner.stepsLabel}>
          <li data-state="done">
            <i aria-hidden="true">
              <CheckIcon size={12} />
            </i>
            {homeowner.stepChoose}
          </li>
          <li data-state="now" aria-current="step">
            <i aria-hidden="true">2</i>
            {homeowner.stepSign}
          </li>
          <li>
            <i aria-hidden="true">3</i>
            {homeowner.stepDone}
          </li>
        </ol>

        {option ? (
          <>
            <div className={styles.summary}>
              <small>{homeowner.optionKicker(homeowner.tierLabel[option.tier])}</small>
              <small className={styles.right}>{addressText(proposal.address)}</small>
              <b>{productLine(option)}</b>
              <b className={styles.right}>{money(option.totalCents)}</b>
            </div>
            {financing !== null ? (
              <section className={styles.pay}>
                <h3 className={styles.label}>{homeowner.howYouPay}</h3>
                {/* Facts, not a choice: the API takes no payment method, and financing is a separate approval */}
                <dl className={styles.payList}>
                  <div>
                    <dt>{homeowner.payTotal}</dt>
                    <dd>{money(option.totalCents)}</dd>
                  </div>
                  <div>
                    <dt>{homeowner.payMonthly}</dt>
                    <dd>{homeowner.payMonthlyAmount(financing.monthly)}</dd>
                    <dd className={styles.payTerms}>{homeowner.payMonthlyTerms(financing.apr, financing.months)}</dd>
                  </div>
                </dl>
              </section>
            ) : null}
            {proposal.estimateClause ? <p className={styles.clause}>{homeowner.estimateClause}</p> : null}
          </>
        ) : (
          <Banner tone="danger">{homeowner.optionMissing}</Banner>
        )}

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
        <SignaturePad heading={homeowner.drawHeading} onChange={setDrawn} disabled={sign.isPending} />

        <div className={styles.consent}>
          <Checkbox checked={consent} onChange={setConsent} label={homeowner.consentText} error={consentError} />
          {financing !== null ? <p className={styles.note}>{homeowner.financingSeparate}</p> : null}
        </div>
        {sign.error ? <Banner tone="danger">{sign.error.message}</Banner> : null}
      </div>
    </Sheet>
  );
}
