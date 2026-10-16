import { toE164, type TransferPhoneView } from '@roofline/shared';
import { Banner, Button, Checkbox, Field, Panel, Skeleton, useToast } from '@roofline/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client.ts';
import { errors } from '../../../copy/errors.ts';
import { frontDeskSettings } from '../../../copy/front-desk-settings.ts';
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
  const initial = view.e164 ?? view.prefill ?? '';
  const [value, setValue] = useState(initial);
  const [acknowledged, setAcknowledged] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

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
    <Panel as="section" title={copy.heading} className={styles.panel}>
      <p className={styles.help}>{copy.help}</p>
      <form onSubmit={submit} noValidate className={styles.form}>
        <Field
          label={copy.label}
          name="transferPhone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          className={styles.phone}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setFieldError(undefined);
          }}
          error={fieldError}
        />
        <Checkbox checked={acknowledged} onChange={setAcknowledged} label={copy.ack} />
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={!acknowledged} busy={save.isPending}>
            {save.isPending ? copy.saving : copy.save}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** Where a person sets the phone that calls transfer to. Each person sees and edits only their own. */
export function TransferPhone() {
  const phone = useTransferPhone();

  if (phone.data) return <TransferPhoneForm view={phone.data} />;

  if (phone.isError) {
    return (
      <div className={styles.panel}>
        <Banner
          tone="danger"
          action={
            <Button variant="default" size="sm" onClick={() => void phone.refetch()}>
              {errors.tryAgain}
            </Button>
          }
        >
          {copy.loadFailed}
        </Banner>
      </div>
    );
  }

  return (
    <div role="status" aria-label={copy.loading} className={styles.panel}>
      <Skeleton height="220px" />
    </div>
  );
}
