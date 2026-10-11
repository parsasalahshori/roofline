import { useId } from 'react';
import styles from './Field.module.css';

type FieldA11yInput = {
  id?: string;
  help?: string;
  error?: string;
  /** An aria-describedby the caller already set; the help and error ids are added after it. */
  describedBy?: string;
};

/**
 * The ids and aria attributes a labelled control shares with its help and error text. Used by
 * Field and Select so the two stay in step: the id comes from useId() unless one is given, and
 * the control is described by whichever of help and error are on screen.
 */
export function useFieldA11y({ id: idProp, help, error, describedBy }: FieldA11yInput) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return {
    id,
    helpId,
    errorId,
    'aria-describedby': [describedBy, helpId, errorId].filter(Boolean).join(' ') || undefined,
    'aria-invalid': error ? true : undefined,
  };
}

type FieldMessagesProps = { help?: string; helpId?: string; error?: string; errorId?: string };

/** The help line and the error under a control. The error is an alert so it is read when it appears. */
export function FieldMessages({ help, helpId, error, errorId }: FieldMessagesProps) {
  return (
    <>
      {help ? (
        <p id={helpId} className={styles.help}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </>
  );
}
