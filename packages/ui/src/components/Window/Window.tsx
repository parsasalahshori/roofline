import { useId, useRef, type ReactNode } from 'react';
import { CloseIcon } from '../../close-icon.tsx';
import { TrapScopeContext, useScopedFocusTrap } from '../../focus-trap.ts';
import { IconButton } from '../IconButton/IconButton.tsx';
import styles from './Window.module.css';

export type WindowVariant = 'floating' | 'page';

export type WindowProps = {
  title: string;
  /** Optional decorative app mark. The title remains the dialog's accessible name. */
  titleIcon?: ReactNode;
  description?: string;
  /** A strip of numbers under the title bar. */
  stats?: ReactNode;
  onClose: () => void;
  /** The close button's accessible name. */
  closeLabel: string;
  children: ReactNode;
  /** floating: inset desktop window. page: available phone space above navigation. */
  variant?: WindowVariant;
  /** Pinned to the bottom edge while the body scrolls. */
  footer?: ReactNode;
};

/**
 * The one big window a route opens on the map. A modal dialog named by its title: focus starts on
 * the dialog itself (so a screen reader reads the title), Tab stays inside, Esc and the close button
 * both call onClose, and focus goes back to the opener when it unmounts. The page behind stays clickable.
 * It tells a Sheet rendered inside it (through the trap scope) that it is the Sheet's parent.
 *
 * The title bar and footer are divs, not header and footer, which would count as page landmarks.
 */
export function Window({
  title,
  titleIcon,
  description,
  stats,
  onClose,
  closeLabel,
  children,
  variant = 'floating',
  footer,
}: WindowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const scope = useScopedFocusTrap(ref, { active: true, onEscape: onClose });

  return (
    <TrapScopeContext value={scope}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={styles.window}
        data-variant={variant}
      >
        <div className={styles.titleBar}>
          <div className={styles.heading}>
            {titleIcon ? <span className={styles.titleIcon} aria-hidden="true">{titleIcon}</span> : null}
            <h1 id={titleId} className={styles.title}>
              {title}
            </h1>
            {description ? (
              <p id={descriptionId} className={styles.description}>
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label={closeLabel} icon={<CloseIcon />} onClick={onClose} />
        </div>
        {stats ? <div className={styles.stats}>{stats}</div> : null}
        <div className={styles.body}>{children}</div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </TrapScopeContext>
  );
}
