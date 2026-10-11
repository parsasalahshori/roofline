import { useId } from 'react';
import type { ReactNode, Ref } from 'react';
import styles from './Checkbox.module.css';

export type CheckboxProps = {
  checked: boolean;
  onChange(next: boolean): void;
  /** The accessible name. It sits after the box. */
  label: ReactNode;
  /** Extra detail under the label. It is outside the label, so the name stays the label text. */
  description?: string;
  /** A problem with the choice. It is announced when it appears and marks the input invalid. */
  error?: string;
  disabled?: boolean;
  /** The native checkbox input. */
  ref?: Ref<HTMLInputElement>;
};

export function Checkbox({ checked, onChange, label, description, error, disabled = false, ref }: CheckboxProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.checkbox} data-state={checked ? 'checked' : 'unchecked'}>
      <label className={styles.row} data-disabled={disabled ? true : undefined}>
        <input
          ref={ref}
          type="checkbox"
          className={styles.input}
          checked={checked}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={styles.text}>{label}</span>
      </label>
      {description ? (
        <p id={descriptionId} className={styles.description}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
