import { Checkbox, Field } from '@roofline/ui';
import { measure } from '../../copy/measure.ts';
import type { NewCustomerInput } from '../estimator/types.ts';
import styles from './CustomerStep.module.css';

/** Whether the form has what a new customer needs: a name and a phone. */
export const customerReady = (c: NewCustomerInput): boolean => c.name.trim() !== '' && c.phone.trim() !== '';

/** Name, phone and texting consent for a home with no customer, asked before Make proposal. */
export function CustomerStep({ value, onChange, disabled = false }: { value: NewCustomerInput; onChange: (next: NewCustomerInput) => void; disabled?: boolean }) {
  return (
    <section className={styles.root} aria-labelledby="measure-customer">
      <h2 id="measure-customer" className={styles.title}>
        {measure.customerTitle}
      </h2>
      <p className={styles.hint}>{measure.customerHint}</p>
      <Field label={measure.customerName} value={value.name} disabled={disabled} onChange={(e) => onChange({ ...value, name: e.target.value })} />
      <Field
        label={measure.customerPhone}
        type="tel"
        value={value.phone}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, phone: e.target.value })}
      />
      <Checkbox
        label={measure.customerAskedByText}
        checked={value.askedByText}
        disabled={disabled}
        onChange={(next) => onChange({ ...value, askedByText: next })}
      />
    </section>
  );
}
