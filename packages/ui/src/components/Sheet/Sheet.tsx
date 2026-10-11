import { useId, useRef, type ReactNode } from 'react';
import { CloseIcon } from '../../close-icon.tsx';
import { useFocusTrap } from '../../focus-trap.ts';
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
 * It is fixed to the viewport, so a Window does not clip it, but inside a Window it stays in the
 * Window's layer (a fixed element is its own stacking context). To lift it above the dock, render
 * it beside the Window instead of inside it.
 */
export function Sheet({ open, title, onClose, closeLabel, children, footer }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, { active: open, onEscape: onClose });

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={styles.sheet}
    >
      <div className={styles.titleBar}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <IconButton label={closeLabel} icon={<CloseIcon />} onClick={onClose} />
      </div>
      <div className={styles.body}>{children}</div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}
