import styles from './Toggle.module.css';

export type ToggleProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** What the switch turns on. It is the accessible name whether or not it is shown. */
  label: string;
  /** Keep the label for assistive tech but do not draw it. */
  labelHidden?: boolean;
  disabled?: boolean;
};

export function Toggle({ checked, onChange, label, labelHidden = false, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelHidden ? label : undefined}
      data-state={checked ? 'on' : 'off'}
      disabled={disabled}
      className={styles.toggle}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {labelHidden ? null : <span className={styles.label}>{label}</span>}
    </button>
  );
}
