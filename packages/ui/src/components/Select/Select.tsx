import { cx } from '../../cx.ts';
import fieldStyles from '../Field/Field.module.css';
import { FieldMessages, useFieldA11y } from '../Field/fieldParts.tsx';
import styles from './Select.module.css';

export type SelectOption = { value: string; label: string };

export type SelectProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<SelectOption>;
  help?: string;
  error?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
};

/** A labelled native <select>, so the platform picker and keyboard handling come for free. */
export function Select({ label, value, onChange, options, help, error, disabled = false, id: idProp, className }: SelectProps) {
  const a11y = useFieldA11y({ id: idProp, help, error });

  return (
    <div className={cx(fieldStyles.field, className)} data-invalid={error ? true : undefined}>
      <label htmlFor={a11y.id} className={fieldStyles.label}>
        {label}
      </label>
      <select
        id={a11y.id}
        className={cx(fieldStyles.control, styles.select)}
        value={value}
        disabled={disabled}
        aria-describedby={a11y['aria-describedby']}
        aria-invalid={a11y['aria-invalid']}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessages help={help} helpId={a11y.helpId} error={error} errorId={a11y.errorId} />
    </div>
  );
}
