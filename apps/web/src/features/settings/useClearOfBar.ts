import { useLayoutEffect, type RefObject } from 'react';

const PROPERTY = 'scroll-padding-bottom';

/**
 * While a bar rides the foot of the window (the save bar, the import's step bar) the column that scrolls keeps whatever is
 * focused or scrolled to above it: the column's scroll-padding grows by the bar's height and its gap, and goes back when the
 * bar is gone. Without it a field at the bottom of the window can be focused and sit behind the bar; and a field that is
 * under the bar the moment it appears (the person was typing in it) is scrolled up above it.
 */
export function useClearOfBar(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return undefined;
    let column: HTMLElement | null = bar.parentElement;
    while (column && !/auto|scroll/.test(getComputedStyle(column).overflowY)) column = column.parentElement;
    if (!column) return undefined;
    const scroller = column;
    const before = scroller.style.getPropertyValue(PROPERTY);
    const apply = () => {
      const gap = Number.parseFloat(getComputedStyle(bar).bottom) || 0;
      scroller.style.setProperty(PROPERTY, `${Math.ceil(bar.offsetHeight + gap + 12)}px`);
    };
    apply();
    // The bar often appears because of a key pressed in a field at the foot of the window: lift that field above it
    const active = document.activeElement;
    if (active instanceof HTMLElement && scroller.contains(active) && !bar.contains(active) && typeof active.scrollIntoView === 'function') {
      const field = active.getBoundingClientRect();
      const box = bar.getBoundingClientRect();
      if (field.bottom > box.top && field.top < box.bottom && field.right > box.left && field.left < box.right) {
        active.scrollIntoView({ block: 'nearest' });
      }
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      if (before === '') scroller.style.removeProperty(PROPERTY);
      else scroller.style.setProperty(PROPERTY, before);
    };
  }, [ref]);
}
