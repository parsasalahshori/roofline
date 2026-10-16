import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../cx.ts';
import fieldStyles from '../Field/Field.module.css';
import { FieldMessages, useFieldA11y } from '../Field/fieldParts.tsx';
import { Icon } from '../../icons.tsx';
import { Popover } from '../Popover/Popover.tsx';
import styles from './Listbox.module.css';
import { useListNav } from './useListNav.ts';

export type ListboxOption<V extends string = string> = {
  value: V;
  label: string;
  /** A glyph or a dot before the label. */
  icon?: ReactNode;
  disabled?: boolean;
};

export type ListboxProps<V extends string = string> = {
  /** The control's name. With variant "field" it is the visible label above the control. */
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: ReadonlyArray<ListboxOption<V>>;
  /** field: a form control with its label above. chip: a 28px pill for a filter bar, "Assigned: Anyone". */
  variant?: 'field' | 'chip';
  /** Shown when `value` matches no option. */
  placeholder?: string;
  help?: string;
  error?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
};

/**
 * A pick-one control that opens a popover list: the replacement for a native select (Assigned, Source, Time zone,
 * Style). The trigger is a button with aria-haspopup="listbox"; the list keeps focus while it is open and is
 * driven by the keyboard (arrows, Home, End, a letter, Enter, Esc). A selection puts focus back on the trigger.
 */
export function Listbox<V extends string = string>({
  label,
  value,
  onChange,
  options,
  variant = 'field',
  placeholder,
  help,
  error,
  disabled = false,
  id: idProp,
  className,
}: ListboxProps<V>) {
  const a11y = useFieldA11y({ id: idProp, help, error });
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  }

  const trigger = (
    <button
      ref={triggerRef}
      id={a11y.id}
      type="button"
      className={cx(variant === 'field' ? fieldStyles.control : undefined, styles.trigger)}
      data-variant={variant}
      data-placeholder={selected ? undefined : 'true'}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-label={variant === 'chip' ? `${label}: ${selected?.label ?? placeholder ?? ''}` : undefined}
      aria-describedby={variant === 'field' ? a11y['aria-describedby'] : undefined}
      aria-invalid={variant === 'field' ? a11y['aria-invalid'] : undefined}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={onTriggerKeyDown}
    >
      {variant === 'chip' ? <span className={styles.chipLabel}>{label}</span> : null}
      <span className={styles.value}>
        {selected?.icon ? <span className={styles.icon}>{selected.icon}</span> : null}
        {selected?.label ?? placeholder ?? ''}
      </span>
      <Icon name="chevd" size={16} className={styles.chevron} />
    </button>
  );

  return (
    <div className={cx(variant === 'field' ? fieldStyles.field : styles.chipWrap, className)} data-invalid={error ? true : undefined}>
      {variant === 'field' ? (
        <label htmlFor={a11y.id} className={fieldStyles.label}>
          {label}
        </label>
      ) : null}
      {trigger}
      {open ? (
        <Popover anchorRef={triggerRef} onDismiss={() => close(false)} matchWidth>
          <ListboxList
            id={listId}
            label={label}
            options={options}
            selected={value}
            listRef={listRef}
            onPick={(next) => {
              onChange(next as V);
              close(true);
            }}
            onEscape={() => close(true)}
            onTab={() => close(false)}
          />
        </Popover>
      ) : null}
      {variant === 'field' ? <FieldMessages help={help} helpId={a11y.helpId} error={error} errorId={a11y.errorId} /> : null}
    </div>
  );
}

type ListProps = {
  id: string;
  label: string;
  options: ReadonlyArray<ListboxOption>;
  selected: string;
  listRef: React.RefObject<HTMLDivElement | null>;
  onPick: (value: string) => void;
  onEscape: () => void;
  onTab: () => void;
};

/** The open list. Mounted only while open, so focus moves into it as it appears. */
function ListboxList({ id, label, options, selected, listRef, onPick, onEscape, onTab }: ListProps) {
  const nav = useListNav(options, options.findIndex((option) => option.value === selected), onPick, onEscape);
  const optionId = (index: number) => `${id}-${index}`;

  return (
    <div
      ref={(node) => {
        listRef.current = node;
        // Focus lands on the list as it is mounted, so the keys work at once
        node?.focus({ preventScroll: true });
      }}
      id={id}
      role="listbox"
      aria-label={label}
      aria-activedescendant={optionId(nav.active)}
      // A tab stop, not -1: the popover around it scrolls on a short screen, and a scrolling region must be reachable by keyboard
      tabIndex={0}
      className={styles.list}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          onTab();
          return;
        }
        nav.onKeyDown(event);
      }}
    >
      {options.map((option, index) => (
        <div
          key={option.value}
          id={optionId(index)}
          role="option"
          aria-selected={option.value === selected}
          aria-disabled={option.disabled || undefined}
          className={styles.option}
          data-active={index === nav.active ? 'true' : undefined}
          data-selected={option.value === selected ? 'true' : undefined}
          onMouseMove={() => nav.setActive(index)}
          onClick={() => {
            if (!option.disabled) onPick(option.value);
          }}
        >
          {option.icon ? <span className={styles.icon}>{option.icon}</span> : null}
          <span className={styles.optionLabel}>{option.label}</span>
          {option.value === selected ? <Icon name="check" size={16} className={styles.check} /> : null}
        </div>
      ))}
    </div>
  );
}
