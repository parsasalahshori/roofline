import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../cx.ts';
import styles from './Popover.module.css';

export type PopoverProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** The control the popover hangs from. It is placed under it, or over it when there is no room below. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Called when a press lands outside the popover and its anchor. */
  onDismiss: () => void;
  /** Which edge of the anchor the popover lines up with. */
  align?: 'start' | 'end';
  /** Makes the popover at least as wide as the anchor. */
  matchWidth?: boolean;
  children: ReactNode;
  ref?: RefObject<HTMLDivElement | null>;
};

const GAP = 6;
const MARGIN = 8;

/**
 * A floating panel at the body, placed by the anchor's position on screen. It is portaled so that a scrolling lane or a
 * panel with overflow hidden cannot cut it off, and it follows the anchor while the page scrolls or resizes. Focus is
 * the caller's job: this places and dismisses, nothing more.
 */
export function Popover({ anchorRef, onDismiss, align = 'start', matchWidth = false, className, children, ref, style, ...rest }: PopoverProps) {
  const innerRef = useRef<HTMLDivElement>(null);
  const popoverRef = ref ?? innerRef;
  const [place, setPlace] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const below = rect.bottom + GAP;
    const above = rect.top - GAP - height;
    // Under the anchor, unless that runs off the screen and over it fits
    const top = below + height > window.innerHeight - MARGIN && above >= MARGIN ? above : below;
    const wanted = align === 'end' ? rect.right - width : rect.left;
    const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN));
    setPlace((current) =>
      current && current.top === top && current.left === left && current.minWidth === rect.width ? current : { top, left, minWidth: rect.width },
    );
  }, [align, anchorRef, popoverRef]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition, children]);

  useEffect(() => {
    window.addEventListener('resize', reposition);
    // Capture: a scroll in any lane or panel moves the anchor
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [reposition]);

  useEffect(() => {
    function onPress(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onDismiss();
    }
    document.addEventListener('mousedown', onPress);
    return () => document.removeEventListener('mousedown', onPress);
  }, [anchorRef, onDismiss, popoverRef]);

  return createPortal(
    <div
      {...rest}
      ref={popoverRef}
      className={cx(styles.popover, className)}
      style={{ ...style, top: place?.top ?? 0, left: place?.left ?? 0, minWidth: matchWidth ? place?.minWidth : undefined, visibility: place ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}
