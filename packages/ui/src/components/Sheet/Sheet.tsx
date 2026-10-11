import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../../close-icon.tsx';
import { TrapScopeContext, useScopedFocusTrap } from '../../focus-trap.ts';
import { IconButton } from '../IconButton/IconButton.tsx';
import styles from './Sheet.module.css';

export type SheetProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  /** The close button's accessible name. */
  closeLabel: string;
  children: ReactNode;
  /** Pinned to the bottom edge while the body scrolls. */
  footer?: ReactNode;
};

/**
 * A panel for one focused task: a bottom sheet on phones, a right-side panel on desktop. A modal
 * dialog like Window, with its own focus trap: opened over a Window, it alone answers Tab and Esc
 * until it closes. Renders nothing while closed.
 *
 * It is portaled into document.body, so wherever it is rendered from (inside a Window too) it sits
 * above the Window and the dock. Layers: Window 20, dock 30, Sheet 40, toasts 50.
 */
export function Sheet({ open, title, onClose, closeLabel, children, footer }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const scope = useScopedFocusTrap(ref, { active: open, onEscape: onClose });

  if (!open) return null;

  // A portal keeps React context, so the trap still knows which Window it was rendered under.
  return createPortal(
    <TrapScopeContext value={scope}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={styles.sheet}>
        <div className={styles.titleBar}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <IconButton label={closeLabel} icon={<CloseIcon />} onClick={onClose} />
        </div>
        <div className={styles.body}>{children}</div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </TrapScopeContext>,
    document.body,
  );
}
