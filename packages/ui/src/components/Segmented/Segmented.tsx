import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../cx.ts';
import styles from './Segmented.module.css';

export type SegmentedOption<V extends string = string> = {
  value: V;
  label: string;
  icon?: ReactNode;
  /** A number after the label, in mono. */
  count?: number | string;
};

export type SegmentedProps<V extends string = string> = {
  /** The group's accessible name. */
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: ReadonlyArray<SegmentedOption<V>>;
  size?: 'sm' | 'md';
  className?: string;
};

/**
 * A track of 2 to 4 choices where exactly one is picked (Board, List, Map; Roof, Windows, Gutters). It is a radio group:
 * Tab enters it once, the arrow keys move the choice, and the picked one has its own raised segment.
 */
export function Segmented<V extends string = string>({ label, value, onChange, options, size = 'md', className }: SegmentedProps<V>) {
  const name = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (index + 1) % options.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (index + last) % options.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current.get(option.value)?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.track, className)} data-size={size}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) refs.current.set(option.value, node);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            name={name}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={styles.segment}
            data-on={checked ? 'true' : undefined}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
          >
            {option.icon ? (
              <span className={styles.icon} aria-hidden="true">
                {option.icon}
              </span>
            ) : null}
            <span>{option.label}</span>
            {option.count !== undefined ? <> <span className={styles.count}>{option.count}</span></> : null}
          </button>
        );
      })}
    </div>
  );
}
