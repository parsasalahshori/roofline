import { Button, Sheet, useToast } from '@roofline/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client.ts';
import { common } from '../../copy/common.ts';
import { create } from '../../copy/create.ts';
import { errors } from '../../copy/errors.ts';
import { AddressFields, EMPTY_ADDRESS, type AddressValue } from './AddressFields.tsx';
import { useCreateProperty } from './api.ts';
import styles from './Create.module.css';

export type AddHomeSheetProps = { customerId: string; onDone?: () => void };

type AddressKey = keyof AddressValue;
const ADDRESS_KEYS: readonly string[] = ['addressLine', 'city', 'state', 'zip'];

/** A panel to add one home to a customer. The server places the home on the map; a home it cannot place still saves. */
export function AddHomeSheet({ customerId, onDone }: AddHomeSheetProps) {
  const toast = useToast();
  const createProperty = useCreateProperty();
  const formId = useId();
  const [address, setAddress] = useState<AddressValue>(EMPTY_ADDRESS);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<AddressKey, string>>>({});

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    try {
      const home = await createProperty.mutateAsync({
        customerId,
        addressLine: address.addressLine,
        city: address.city,
        state: address.state,
        zip: address.zip,
      });
      if (home.lat === null || home.lng === null) toast.show(create.notOnMap, 'info');
      onDone?.();
    } catch (error) {
      if (error instanceof ApiError && error.field !== undefined && ADDRESS_KEYS.includes(error.field)) {
        setFieldErrors({ [error.field]: error.message });
      } else {
        toast.show(error instanceof ApiError ? error.message : errors.generic, 'error');
      }
    }
  }

  return (
    <Sheet
      open
      title={create.addHome.title}
      closeLabel={common.close}
      onClose={() => onDone?.()}
      footer={
        <Button type="submit" form={formId} variant="primary" busy={createProperty.isPending}>
          {createProperty.isPending ? create.saving : create.addHome.save}
        </Button>
      }
    >
      <form id={formId} className={styles.sheetForm} onSubmit={(event) => void save(event)}>
        <AddressFields value={address} onChange={setAddress} errors={fieldErrors} />
      </form>
    </Sheet>
  );
}
