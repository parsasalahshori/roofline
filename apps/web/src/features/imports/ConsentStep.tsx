import { useRef, useState } from 'react';
import { consentAttestationText } from '@roofline/shared';
import { Button, Checkbox, Panel, Skeleton } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { importCopy } from '../../copy/import.ts';
import { useCompany } from '../settings/api.ts';
import { useImport, useStartImport } from './api.ts';
import styles from './ImportWizard.module.css';
import { WizardActions } from './WizardActions.tsx';

export type ConsentStepProps = { importId: string; onBack: () => void };

/** Asks for the texting permission, shows how many opted-out customers stay off, and starts the import. */
export function ConsentStep({ importId, onBack }: ConsentStepProps) {
  const [checked, setChecked] = useState(false);
  const company = useCompany();
  const query = useImport(importId, checked);
  const start = useStartImport(importId);
  const startedRef = useRef(false);

  const onImport = () => {
    if (startedRef.current || start.isPending) return;
    const companyName = company.data?.name;
    if (checked && companyName === undefined) return;
    startedRef.current = true;
    const body = checked
      ? { consentAttested: true as const, consentText: consentAttestationText(companyName ?? '') }
      : { consentAttested: false as const };
    start.mutate(body, {
      onSettled: () => {
        startedRef.current = false;
      },
    });
  };

  const view = query.data;
  const startError = start.error instanceof ApiError && start.error.status !== 409 ? start.error.message : null;

  return (
    <>
      <Panel title={importCopy.consentTitle}>
        {company.data ? (
          <Checkbox
            checked={checked}
            onChange={(next) => setChecked(next)}
            label={consentAttestationText(company.data.name)}
          />
        ) : (
          <Skeleton height="2.5rem" />
        )}
        {!checked ? <p className={`${styles.note} ${styles.after}`}>{importCopy.consentUncheckedNote}</p> : null}
        {view && view.counts.consent.optedOutKept > 0 ? (
          <p className={`${styles.note} ${styles.after}`}>{importCopy.optedOutKept(view.counts.consent.optedOutKept)}</p>
        ) : null}
        {startError !== null ? (
          <p className={`${styles.error} ${styles.after}`} role="alert">
            {startError}
          </p>
        ) : null}
      </Panel>
      <WizardActions status={importCopy.stepOf(4, 5)}>
        <Button type="button" variant="default" onClick={onBack}>
          {importCopy.back}
        </Button>
        <Button type="button" variant="primary" busy={start.isPending} onClick={onImport}>
          {importCopy.startImport}
        </Button>
      </WizardActions>
    </>
  );
}
