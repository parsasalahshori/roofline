import { useId, useRef, type ReactNode } from 'react';
import { CloseIcon } from '../../close-icon.tsx';
import { TrapScopeContext, useScopedFocusTrap } from '../../focus-trap.ts';
import { IconButton } from '../IconButton/IconButton.tsx';
import styles from './Window.module.css';

export type WindowVariant = 'floating' | 'page';

export type WindowProps = {
  title: string;
  description?: string;
  /** A strip of numbers under the title bar. */
  stats?: ReactNode;
  onClose: () => void;
  /** The close button's accessible name. */
  closeLabel: string;
  children: ReactNode;
  /** floating: about 90% of the viewport, centered, with the map around it. page: the whole screen, for phones. */
  variant?: WindowVariant;
  /** Pinned to the bottom edge while the body scrolls. */
  footer?: ReactNode;
  /** A glyph for the app's icon tile at the left of the title (decorative; the title names the window). */
  icon?: ReactNode;
  /** The tile's CSS background (a colour or gradient) and glyph colour. */
  iconBackground?: string;
  iconColor?: string;
  /** The window's children draw their own header: the title stays for screen readers and only the close button shows, over the corner. */
  bare?: boolean;
  /** Floating only: fills the screen between the top bar and the dock with a 20px margin, for a window with columns. */
  wide?: boolean;
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
  description,
  stats,
  onClose,
  closeLabel,
  children,
  variant = 'floating',
  footer,
  icon,
  iconBackground,
  iconColor,
  bare = false,
  wide = false,
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
        data-bare={bare ? 'true' : undefined}
        data-wide={wide ? 'true' : undefined}
      >
        <div className={styles.titleBar}>
          {icon ? (
            <span className={styles.tile} aria-hidden="true" style={{ background: iconBackground, color: iconColor }}>
              {icon}
            </span>
          ) : null}
          <div className={styles.heading}>
            <h1 id={titleId} className={styles.title}>
              {title}
            </h1>
            {description ? (
              <p id={descriptionId} className={styles.description}>
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label={closeLabel} icon={<CloseIcon />} className={styles.close} onClick={onClose} />
        </div>
        {stats ? <div className={styles.stats}>{stats}</div> : null}
        <div className={styles.body}>{children}</div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </TrapScopeContext>
  );
}
