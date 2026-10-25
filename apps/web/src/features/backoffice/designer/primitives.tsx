// Small iOS-style building blocks for the designer: inset grouped lists, rows, pop-up selects and steppers.
import { Icon, IconButton } from '@roofline/ui';
import { useId, useState, type ReactNode } from 'react';
import { formatInches, parseInches } from '../drawing/inches.ts';
import styles from './primitives.module.css';

/** An inset grouped list: a small caps title above, rounded rows, a footnote below. */
export function Group({ title, footer, children, className }: { title?: string; footer?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`${styles.group} ${className ?? ''}`} aria-labelledby={title ? id : undefined}>
      {title ? (
        <h3 id={id} className={styles.groupTitle}>
          {title}
        </h3>
      ) : null}
      <div className={styles.list}>{children}</div>
      {footer ? <p className={styles.groupFooter}>{footer}</p> : null}
    </section>
  );
}

/** A row: the label on the left, the control on the right. A `<label>` so tapping the label focuses the control. */
export function Row({ label, children, stacked = false, as = 'label' }: { label: ReactNode; children?: ReactNode; stacked?: boolean; as?: 'label' | 'div' }) {
  const Tag = as;
  return (
    <Tag className={styles.row} data-stacked={stacked ? 'true' : undefined}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{children}</span>
    </Tag>
  );
}

/** A pop-up choice, right aligned like a pull-down on iOS, with the chevron pair. */
export function SelectRow({ label, value, options, onChange, disabled }: { label: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Row label={label}>
      <span className={styles.select}>
        <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevd" size={16} />
      </span>
    </Row>
  );
}

/** Text in a row, saved as you type. */
export function TextRow({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Row label={label}>
      <input className={styles.input} aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </Row>
  );
}

/** A size in inches typed with fractions ("35 1/2"): committed on Enter or leaving the field; a bad entry goes back to what it was. */
export function InchesRow({ label, value, onCommit, disabled, unit }: { label: string; value: number; onCommit: (inches: number) => void; disabled?: boolean; unit?: string }) {
  const [text, setText] = useState(formatInches(value));
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(value);
  // The size changed from outside (a drag on the drawing): show it, unless the person is typing
  if (seen !== value) {
    setSeen(value);
    if (!editing) setText(formatInches(value));
  }
  const commit = () => {
    setEditing(false);
    const parsed = parseInches(text);
    if (parsed === null) setText(formatInches(value));
    else {
      setText(formatInches(parsed));
      if (parsed !== value) onCommit(parsed);
    }
  };
  return (
    <Row label={label}>
      <input
        className={styles.input}
        inputMode="text"
        aria-label={label}
        value={text}
        disabled={disabled}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(formatInches(value));
            setEditing(false);
          }
        }}
      />
      {unit ? <span className={styles.unit}>{unit}</span> : null}
    </Row>
  );
}

/** − 2 +, the iOS stepper. */
export function Stepper({ label, value, min, max, onChange, minusLabel, plusLabel }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; minusLabel: string; plusLabel: string }) {
  return (
    <span className={styles.stepper} role="group" aria-label={label}>
      <IconButton label={minusLabel} icon={<Icon name="minus" size={18} />} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} />
      <output className={styles.stepperValue} aria-label={label}>
        {value}
      </output>
      <IconButton label={plusLabel} icon={<Icon name="plus" size={18} />} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} />
    </span>
  );
}
