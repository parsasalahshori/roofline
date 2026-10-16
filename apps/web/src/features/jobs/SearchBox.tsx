import { Icon } from '@roofline/ui';
import { useEffect, useRef } from 'react';
import styles from './SearchBox.module.css';

export type SearchBoxProps = {
  /** The box's accessible name (it has no visible label: the placeholder says what to type). */
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** Press "/" anywhere on the page to jump here; the hint is drawn at the right while the box is empty. */
  slashFocus?: boolean;
  className?: string;
};

/** Where the "/" key must not steal focus: a field being typed in, or a dialog that holds the focus. */
function typingElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** A 30px search field for a filter bar: a magnifier, the typed text, and a "/" key hint. Esc leaves it. */
export function SearchBox({ label, placeholder, value, onChange, slashFocus = true, className }: SearchBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!slashFocus) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || typingElsewhere(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [slashFocus]);

  return (
    <div className={[styles.box, className].filter(Boolean).join(' ')} data-filled={value === '' ? undefined : 'true'}>
      <Icon name="search" size={16} className={styles.icon} />
      <input
        ref={inputRef}
        type="search"
        className={styles.input}
        aria-label={label}
        aria-keyshortcuts={slashFocus ? '/' : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur();
        }}
      />
      {slashFocus ? (
        <kbd className={styles.key} aria-hidden="true">
          /
        </kbd>
      ) : null}
    </div>
  );
}
