import { IconButton, useFocusTrap } from '@roofline/ui';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useMe, useSearch } from '../../api/hooks.ts';
import { search } from '../../copy/search.ts';
import styles from './SearchDialog.module.css';
import { SearchIcon } from './searchIcon.tsx';
import { readRecents } from '../recents.ts';
import { OPEN_SEARCH_EVENT } from './openSearch.ts';
import { actionOptions, measureOptions, recentOptions, toOptions, type SearchOption } from './searchOptions.ts';

/** The groups in the order the dialog shows them. Each key is also the name of its heading in `search`. */
const GROUPS = ['actions', 'recent', 'customers', 'jobs', 'addresses'] as const;

/** Wait this long after the last key before asking, so a fast typist asks once. */
const DEBOUNCE_MS = 200;

/** Down goes to the next result and wraps to the first; up goes to the previous and, from the first or from nothing, to the last. */
function stepIndex(current: number, count: number, direction: 'down' | 'up'): number {
  if (direction === 'down') return (current + 1) % count;
  return current <= 0 ? count - 1 : current - 1;
}

/** The search button in the top bar, and the search it opens. Cmd+K or Ctrl+K opens it from anywhere. */
export function SearchDialog() {
  const [open, setOpen] = useState(false);

  // Cmd+K on a Mac, Ctrl+K elsewhere: works from anywhere on the page, including inside a text field
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    }
    const onRequest = () => setOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_SEARCH_EVENT, onRequest);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_SEARCH_EVENT, onRequest);
    };
  }, []);

  return (
    <>
      <IconButton
        label={search.open}
        icon={<SearchIcon />}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={styles.trigger}
      />
      {open ? <SearchPanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** One line of text under the field: the hint, "searching", an error, or no matches. */
function StatusLine({ text }: { text: string }) {
  return (
    <p role="status" className={styles.status}>
      {text}
    </p>
  );
}

/** The dialog itself. Mounted while open, so every opening starts with an empty field and nothing active. */
function SearchPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  // `value` is what is typed; `debounced` follows it once the typing pauses
  const [value, setValue] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  const me = useMe();
  const companyId = me.data?.company.id;
  const canDownload = me.data?.role === 'owner' || me.data?.role === 'office';
  const recents = useMemo(() => recentOptions(companyId ? readRecents(companyId) : []), [companyId]);
  const query = useSearch(debounced);
  // Esc closes the dialog and focus goes back to whatever had it; Tab stays inside
  useFocusTrap(dialogRef, { active: true, onEscape: onClose, initialFocus: inputRef });

  // Only the answer for exactly what is in the field counts. While a new query waits out the debounce
  // or loads, the old results are off the screen, so the arrow keys and Enter must not reach them.
  const current = value.trim().length >= 2 && debounced === value && query.isSuccess;
  const typing = value.trim() !== '';
  const actions = useMemo(() => [...measureOptions(value), ...actionOptions(value, canDownload)], [value, canDownload]);
  const found = current && query.data ? toOptions(query.data) : [];
  const options = typing ? [...actions, ...found] : recents;
  // Looked up by key, so an option that is no longer in the results is no longer active
  const active = options.find((option) => option.key === activeKey);
  const activeIndex = active ? options.indexOf(active) : -1;
  const optionId = (index: number) => `${listId}-option-${index}`;
  const activeId = active ? optionId(activeIndex) : undefined;
  const showList = options.length > 0;

  // Keep the active result on screen while the arrow keys move through a long list
  useEffect(() => {
    if (activeId === undefined) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  function select(option: SearchOption) {
    if (option.external) window.location.assign(option.href);
    else void navigate(option.href);
    onClose();
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length === 0) return;
      event.preventDefault();
      const next = options[stepIndex(activeIndex, options.length, event.key === 'ArrowDown' ? 'down' : 'up')];
      if (next) setActiveKey(next.key);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      select(active);
    }
  }

  const list = (
      <div role="listbox" id={listId} aria-label={search.listLabel} className={styles.results}>
        {GROUPS.map((group) => {
          const items = options.map((option, index) => ({ option, index })).filter(({ option }) => option.group === group);
          if (items.length === 0) return null;
          const headingId = `${listId}-${group}`;
          return (
            <div key={group} role="group" aria-labelledby={headingId} className={styles.group}>
              <div id={headingId} className={styles.heading}>
                {search[group]}
              </div>
              {items.map(({ option, index }) => {
                const isActive = option === active;
                return (
                  <div
                    key={option.key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    className={styles.option}
                    onClick={() => select(option)}
                  >
                    <span className={styles.primary}>{option.primary}</span>
                    {option.secondary ? <span className={styles.secondary}>{option.secondary}</span> : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
  );

  let content: ReactNode;
  if (showList) {
    const loading = typing && value.trim().length >= 2 && (debounced !== value || query.isPending);
    content = (
      <>
        {list}
        {loading ? <StatusLine text={search.searching} /> : null}
      </>
    );
  } else if (!typing || value.trim().length < 2) {
    content = <StatusLine text={search.hint} />;
  } else if (debounced !== value || query.isPending) {
    content = <StatusLine text={search.searching} />;
  } else if (query.isError) {
    content = <StatusLine text={query.error.message} />;
  } else {
    content = <StatusLine text={search.noMatches(debounced)} />;
  }

  // Portaled to the body, so the dialog sits above the top bar, the Window and the dock
  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={search.dialogTitle} tabIndex={-1} className={styles.dialog}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-label={search.inputLabel}
          placeholder={search.placeholder}
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={activeId}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setActiveKey(null);
          }}
          onKeyDown={onInputKeyDown}
          className={styles.input}
        />
        {content}
      </div>
    </div>,
    document.body,
  );
}
