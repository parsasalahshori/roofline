import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from '../../cx.ts';
import { FieldMessages, useFieldA11y } from './fieldParts.tsx';
import styles from './Field.module.css';

export type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  help?: string;
  error?: string;
  /** A textarea instead of an input. Handlers still receive the change event; read event.target.value. */
  multiline?: boolean;
  rows?: number;
};

/**
 * A labelled text control. `className` and `style` go on the wrapper (layout); everything else
 * goes on the input or textarea.
 */
export function Field({
  label,
  help,
  error,
  multiline = false,
  rows = 3,
  type,
  id: idProp,
  className,
  style,
  'aria-describedby': describedByProp,
  ...rest
}: FieldProps) {
  const a11y = useFieldA11y({ id: idProp, help, error, describedBy: describedByProp });
  const control = {
    id: a11y.id,
    className: styles.control,
    'aria-describedby': a11y['aria-describedby'],
    'aria-invalid': a11y['aria-invalid'],
  };

  return (
    <div className={cx(styles.field, className)} style={style} data-invalid={error ? true : undefined}>
      <label htmlFor={a11y.id} className={styles.label}>
        {label}
      </label>
      {multiline ? (
        <textarea {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} {...control} rows={rows} />
      ) : (
        <input {...rest} {...control} type={type} />
      )}
      <FieldMessages help={help} helpId={a11y.helpId} error={error} errorId={a11y.errorId} />
    </div>
  );
}
