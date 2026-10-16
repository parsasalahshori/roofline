import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../../cx.ts';
import { Icon } from '../../icons.tsx';
import { Popover } from '../Popover/Popover.tsx';
import { useListNav, type NavOption } from '../Listbox/useListNav.ts';
import styles from './StageMenu.module.css';

export type StageMenuStage = {
  key: string;
  label: string;
  /** The stage's colour, as a CSS value: the dot beside its name. */
  color?: string;
};

export type StageMenuExtra = {
  key: string;
  label: string;
  /** The key that picks it from the keyboard, shown as a hint: "L", "E". */
  shortcut: string;
  /** bad: a destructive choice, written in red with its word. */
  tone?: 'bad';
};

export type StageMenuProps = {
  /** The trigger's accessible name, e.g. "Move to…". */
  label: string;
  /** The list's own heading, e.g. "Move to stage". */
  heading: string;
  stages: ReadonlyArray<StageMenuStage>;
  /** The stage the job is in now: it carries the check. */
  current: string;
  /** Choices under a rule after the stages (Lost, Archive). */
  extras?: ReadonlyArray<StageMenuExtra>;
  onPick: (key: string) => void;
  /** Writes the label on the trigger beside the chevron, for a menu with no quick-move button next to it. */
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
};

/**
 * The menu that replaces a native "Move to…" select on a job: a button that opens a listbox of the stages, the current
 * one checked, each with its number key, then Lost and Archive under a rule. Open, press 1 to 6 to move at once. It keeps
 * focus on the list and points at an option with aria-activedescendant, so the arrows and Enter work as in a select.
 */
export function StageMenu({ label, heading, stages, current, extras = [], onPick, showLabel = false, disabled = false, className }: StageMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);

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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx(styles.trigger, className)}
        aria-label={label}
        data-labelled={showLabel ? 'true' : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
      >
        {showLabel ? <span>{label}</span> : null}
        <Icon name="chevd" size={16} />
      </button>
      {open ? (
        <Popover anchorRef={triggerRef} align="end" className={styles.popover} onDismiss={() => close(false)}>
          <StageList
            id={listId}
            heading={heading}
            stages={stages}
            current={current}
            extras={extras}
            onPick={(key) => {
              close(true);
              if (key !== current) onPick(key);
            }}
            onEscape={() => close(true)}
            onTab={() => close(false)}
          />
        </Popover>
      ) : null}
    </>
  );
}

type ListProps = {
  id: string;
  heading: string;
  stages: ReadonlyArray<StageMenuStage>;
  current: string;
  extras: ReadonlyArray<StageMenuExtra>;
  onPick: (key: string) => void;
  onEscape: () => void;
  onTab: () => void;
};

function StageList({ id, heading, stages, current, extras, onPick, onEscape, onTab }: ListProps) {
  const options: NavOption[] = [
    ...stages.map((stage, index) => ({ value: stage.key, label: stage.label, shortcut: String(index + 1) })),
    ...extras.map((extra) => ({ value: extra.key, label: extra.label, shortcut: extra.shortcut })),
  ];
  const nav = useListNav(options, Math.max(0, stages.findIndex((stage) => stage.key === current)), onPick, onEscape);
  const optionId = (index: number) => `${id}-${index}`;

  return (
    <div
      ref={(node) => node?.focus({ preventScroll: true })}
      id={id}
      role="listbox"
      aria-label={heading}
      aria-activedescendant={optionId(nav.active)}
      tabIndex={-1}
      className={styles.list}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          onTab();
          return;
        }
        nav.onKeyDown(event);
      }}
    >
      <p className={styles.heading} aria-hidden="true">
        {heading}
      </p>
      {stages.map((stage, index) => (
        <div
          key={stage.key}
          id={optionId(index)}
          role="option"
          aria-selected={stage.key === current}
          className={styles.option}
          data-active={index === nav.active ? 'true' : undefined}
          onMouseMove={() => nav.setActive(index)}
          onClick={() => onPick(stage.key)}
        >
          <span className={styles.dot} style={stage.color ? { background: stage.color } : undefined} aria-hidden="true" />
          <span className={styles.name}>{stage.label}</span>
          {stage.key === current ? <Icon name="check" size={16} className={styles.check} /> : null}
          <kbd className={styles.key} aria-hidden="true">
            {index + 1}
          </kbd>
        </div>
      ))}
      {extras.length > 0 ? <hr className={styles.rule} /> : null}
      {extras.map((extra, offset) => {
        const index = stages.length + offset;
        return (
          <div
            key={extra.key}
            id={optionId(index)}
            role="option"
            aria-selected={false}
            className={styles.option}
            data-tone={extra.tone}
            data-active={index === nav.active ? 'true' : undefined}
            onMouseMove={() => nav.setActive(index)}
            onClick={() => onPick(extra.key)}
          >
            <span className={styles.name}>{extra.label}</span>
            <kbd className={styles.key} aria-hidden="true">
              {extra.shortcut}
            </kbd>
          </div>
        );
      })}
    </div>
  );
}
