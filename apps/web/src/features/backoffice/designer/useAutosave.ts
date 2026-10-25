import { useCallback, useEffect, useRef, useState } from 'react';

export const SAVE_DEBOUNCE_MS = 700;
export type SaveState = 'idle' | 'waiting' | 'saving' | 'saved' | 'error';

/**
 * Debounced saving. `change(value)` waits until edits have stopped for `delay` ms, then calls `save` once with the
 * latest value. Edits made while a save is running are sent right after it. `flush()` sends now (and on unmount).
 */
export function useAutosave<T>(save: (value: T) => Promise<unknown>, delay = SAVE_DEBOUNCE_MS) {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<unknown>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef(false);
  const mounted = useRef(true);

  const run = useCallback(async () => {
    if (running.current || pending.current === null) return;
    running.current = true;
    while (pending.current !== null) {
      const { value } = pending.current;
      pending.current = null;
      if (mounted.current) setState('saving');
      try {
        await saveRef.current(value);
        if (mounted.current) setState(pending.current === null ? 'saved' : 'waiting');
      } catch (e) {
        if (mounted.current) {
          setError(e);
          setState('error');
        }
        break;
      }
    }
    running.current = false;
  }, []);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    void run();
  }, [run]);

  const change = useCallback(
    (value: T) => {
      pending.current = { value };
      setState((s) => (s === 'saving' ? s : 'waiting'));
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [delay, flush],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      // Unsent edits go now: leaving the editor for the visualizer must not lose the last change
      if (pending.current !== null) void run();
    };
  }, [run]);

  return { state, error, change, flush };
}
