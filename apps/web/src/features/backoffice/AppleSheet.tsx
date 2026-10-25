import { Button } from '@roofline/ui';
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export type AppleSheetProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
  /** The sheet's main action(s), in the bar at the foot. */
  footer?: ReactNode;
  /** 'modal' is a centred sheet (a bottom sheet on a phone); 'inspector' is a panel at the right. */
  variant?: 'modal' | 'inspector';
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * An Apple-style sheet, drawn in place (not in a portal) so the back office's tokens apply to it. A modal dialog:
 * Escape closes it, Tab stays inside it, and focus returns to what opened it.
 */
export function AppleSheet({ open, title, onClose, closeLabel, children, footer, variant = 'modal' }: AppleSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => before?.focus?.();
  }, [open]);

  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="bo-scrim" data-variant={variant} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="bo-sheet" onKeyDown={onKeyDown}>
        <div className="bo-sheet-bar">
          <span />
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" onClick={onClose}>
            {closeLabel}
          </Button>
        </div>
        <div className="bo-sheet-body">{children}</div>
        {footer ? <div className="bo-sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
