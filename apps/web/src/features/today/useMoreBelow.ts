import { useEffect, useState } from 'react';

/**
 * Whether a scrolling box has more under what it shows. Give the first value to the box as its `ref`; the second says
 * whether to fade its bottom edge, so a card cut by the edge reads as "scroll for more" instead of as a drawing fault,
 * and the fade goes when the end is reached.
 */
export function useMoreBelow<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [box, setBox] = useState<T | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    if (box === null) return;
    const check = () => setMore(box.scrollHeight - box.scrollTop - box.clientHeight > 4);
    check();
    box.addEventListener('scroll', check, { passive: true });
    // Cards come and go and change height as they load, so the box and what is in it are both watched
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    sizes?.observe(box);
    const watched = new Set<Element>();
    const watchChildren = () => {
      for (const child of Array.from(box.children)) {
        if (!watched.has(child)) {
          watched.add(child);
          sizes?.observe(child);
        }
      }
      check();
    };
    watchChildren();
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(watchChildren);
    changes?.observe(box, { childList: true });
    return () => {
      box.removeEventListener('scroll', check);
      sizes?.disconnect();
      changes?.disconnect();
    };
  }, [box]);

  return [setBox, more];
}
