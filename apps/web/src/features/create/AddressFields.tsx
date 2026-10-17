import { US_STATE_NAMES } from '@roofline/shared';
import { Field, Listbox, type ListboxOption } from '@roofline/ui';
import { create } from '../../copy/create.ts';
import styles from './Create.module.css';

export type AddressValue = { addressLine: string; city: string; state: string; zip: string };
export const EMPTY_ADDRESS: AddressValue = { addressLine: '', city: '', state: '', zip: '' };
export type AddressFieldsProps = {
  value: AddressValue;
  onChange: (next: AddressValue) => void;
  /** Server field errors keyed by field: addressLine, city, state, zip. */
  errors?: Partial<Record<keyof AddressValue, string>>;
};

/** The first option is the empty choice; the states follow, sorted by name. */
const STATE_OPTIONS: readonly ListboxOption[] = [
  { value: '', label: create.address.statePlaceholder },
  ...Object.entries(US_STATE_NAMES)
    .map(([code, name]) => ({ value: code, label: name }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];

/** Street, city, state and ZIP for one home. Each control reports the whole address on every change. */
export function AddressFields({ value, onChange, errors = {} }: AddressFieldsProps) {
  return (
    <div className={styles.address}>
      <div className={styles.addressGrid}>
        <Field
          label={create.address.street}
          className={styles.wide}
          autoComplete="street-address"
          value={value.addressLine}
          onChange={(event) => onChange({ ...value, addressLine: event.currentTarget.value })}
          error={errors.addressLine}
        />
        <Field
          label={create.address.city}
          autoComplete="address-level2"
          value={value.city}
          onChange={(event) => onChange({ ...value, city: event.currentTarget.value })}
          error={errors.city}
        />
        <Listbox
          label={create.address.state}
          value={value.state}
          options={STATE_OPTIONS}
          onChange={(state) => onChange({ ...value, state })}
          error={errors.state}
        />
        <Field
          label={create.address.zip}
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={10}
          value={value.zip}
          onChange={(event) => onChange({ ...value, zip: event.currentTarget.value })}
          error={errors.zip}
        />
      </div>
    </div>
  );
}
