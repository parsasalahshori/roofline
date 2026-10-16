import { toE164, type TransferPhoneView } from '@roofline/shared';
import { Checkbox, EmptyState, Field, Panel, Skeleton, useToast } from '@roofline/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client.ts';
import { frontDeskSettings } from '../../../copy/front-desk-settings.ts';
import form from '../../settings/form.module.css';
import { SaveBar } from '../../settings/SaveBar.tsx';
import { useSaveTransferPhone, useTransferPhone } from './settings-api.ts';
import styles from './TransferPhone.module.css';

/*
 * Your phone for transfers (Ruling DF): each person edits only their own number. The field starts
 * from the saved number, or from the phone on the profile when none is saved yet. Nothing is saved
 * until the recording acknowledgement is ticked, and the box is unticked again on every load.
 */

const copy = frontDeskSettings.transferPhone;

type FormProps = { view: TransferPhoneView };

/** Mounted once the view has loaded, so its state is seeded from that view one time. */
function TransferPhoneForm({ view }: FormProps) {
  const save = useSaveTransferPhone();
  const toast = useToast();
  // The number the field was loaded with, and (after a save) the number the server kept: a difference from it is what the save bar is for
  const [baseline, setBaseline] = useState(view.e164 ?? view.prefill ?? '');
  const [value, setValue] = useState(baseline);
  const [acknowledged, setAcknowledged] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const changed = value !== baseline || acknowledged;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!acknowledged || save.isPending) return;
    const normalized = toE164(value);
    if (normalized === null) {
      setFieldError(copy.invalid);
      return;
    }
    setFieldError(undefined);
    save.mutate(
      { e164: normalized, ackRecording: true },
      {
        onSuccess: () => {
          // The field shows the number as saved, and the person re-ticks the box for the next change
          setBaseline(normalized);
          setValue(normalized);
          setAcknowledged(false);
          toast.show(copy.saved, 'success');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.field === 'e164') {
            setFieldError(error.message);
          } else if (error instanceof ApiError) {
            toast.show(error.message, 'error');
          } else {
            toast.show(copy.saveFailed, 'error');
          }
        },
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate className={form.form}>
      <Panel title={copy.heading}>
        <p className={`${form.help} ${styles.help}`}>{copy.help}</p>
        <div className={form.grid}>
          <Field
            label={copy.label}
            name="transferPhone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setFieldError(undefined);
            }}
            error={fieldError}
          />
          <div className={`${form.span} ${styles.ack}`}>
            <Checkbox checked={acknowledged} onChange={setAcknowledged} label={copy.ack} />
          </div>
        </div>
      </Panel>

      <SaveBar
        dirty={changed}
        saving={save.isPending}
        saveLabel={copy.save}
        saveDisabled={!acknowledged}
        onDiscard={() => {
          setValue(baseline);
          setAcknowledged(false);
          setFieldError(undefined);
        }}
      />
    </form>
  );
}

/** Where a person sets the phone that calls transfer to. Each person sees and edits only their own. */
export function TransferPhone() {
  const phone = useTransferPhone();

  if (phone.data) return <TransferPhoneForm view={phone.data} />;

  if (phone.isError) {
    return <EmptyState title={copy.loadFailed} />;
  }

  return (
    <Panel>
      <div role="status">
        <Skeleton lines={2} />
      </div>
    </Panel>
  );
}
