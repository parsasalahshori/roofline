import { useCallback, useState, type KeyboardEvent } from 'react';

export type NavOption = { value: string; label: string; disabled?: boolean; shortcut?: string };

/**
 * The keyboard of a listbox that keeps focus on the list itself and points at the highlighted option with
 * aria-activedescendant: the arrows, Home and End move the highlight, Enter and Space pick it, typing a letter jumps to
 * the next option that starts with it, and an option's own shortcut key picks it straight away.
 */
export function useListNav(options: ReadonlyArray<NavOption>, initial: number, onPick: (value: string) => void, onEscape: () => void) {
  const [active, setActive] = useState(Math.max(0, initial));

  const move = useCallback(
    (from: number, step: 1 | -1) => {
      for (let offset = 1; offset <= options.length; offset += 1) {
        const index = (from + step * offset + options.length * offset) % options.length;
        if (!options[index]?.disabled) return index;
      }
      return from;
    },
    [options],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActive((current) => move(current, 1));
          return;
        case 'ArrowUp':
          event.preventDefault();
          setActive((current) => move(current, -1));
          return;
        case 'Home':
          event.preventDefault();
          setActive(move(-1, 1));
          return;
        case 'End':
          event.preventDefault();
          setActive(move(options.length, -1));
          return;
        case 'Enter':
        case ' ': {
          event.preventDefault();
          const option = options[active];
          if (option && !option.disabled) onPick(option.value);
          return;
        }
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          onEscape();
          return;
        default:
      }
      if (event.key.length !== 1) return;
      const typed = event.key.toLowerCase();
      // A shortcut ("1", "L") picks its option outright
      const shortcut = options.find((option) => !option.disabled && option.shortcut?.toLowerCase() === typed);
      if (shortcut) {
        event.preventDefault();
        onPick(shortcut.value);
        return;
      }
      // Otherwise a letter moves to the next option that starts with it
      const start = active;
      for (let offset = 1; offset <= options.length; offset += 1) {
        const index = (start + offset) % options.length;
        const option = options[index];
        if (option && !option.disabled && option.label.toLowerCase().startsWith(typed)) {
          event.preventDefault();
          setActive(index);
          return;
        }
      }
    },
    [active, move, onEscape, onPick, options],
  );

  return { active, setActive, onKeyDown };
}
