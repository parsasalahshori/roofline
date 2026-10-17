import { useCallback, useSyncExternalStore } from 'react';

/** The size of 1rem in pixels: the page's own font size, so the answer follows the reader's text size as a container query does. */
function remInPixels(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * Whether an element is at least `minRem` wide, kept up to date as it is resized. CSS answers this for layout with a
 * container query; this is for what CSS cannot change. Where nothing can be measured (no element yet, or a test's DOM, which
 * has no layout) the answer is yes: the wide layout is the one that is there before a measure.
 */
export function useContainerWide(element: HTMLElement | null, minRem: number): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (element === null || typeof ResizeObserver === 'undefined') return () => undefined;
      const observer = new ResizeObserver(notify);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [element],
  );
  const read = useCallback((): boolean => {
    if (element === null) return true;
    const width = element.getBoundingClientRect().width;
    return width === 0 || width >= minRem * remInPixels();
  }, [element, minRem]);
  return useSyncExternalStore(subscribe, read, () => true);
}
