import type { ReactNode } from 'react';
import { UiLink } from '../../link.tsx';
import { Badge } from '../Badge/Badge.tsx';
import styles from './Dock.module.css';

export type DockItem = {
  key: string;
  /** Always shown under the icon. */
  label: string;
  href: string;
  icon: ReactNode;
  /** A count on the icon, with what it means as its accessible name. Nothing is drawn at zero. */
  badge?: { count: number; label: string };
  /** For an app that is not built yet: the note shown on hover and read after the label. The link still works. */
  comingSoon?: string;
  current?: boolean;
};

export type DockProps = {
  /** The navigation's accessible name. */
  label: string;
  items: DockItem[];
};

/**
 * The row of apps on desktop. Every item shows its label under its icon, at all times. The dock sets
 * no position of its own: the shell places it, and keeps it clickable above an open window (a Window
 * sits at z-index 20, a Sheet at 30, toasts at 40).
 */
export function Dock({ label, items }: DockProps) {
  return (
    <nav aria-label={label} className={styles.dock}>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.key} className={styles.item}>
            <UiLink
              href={item.href}
              className={styles.link}
              aria-current={item.current ? 'page' : undefined}
              data-state={item.comingSoon ? 'soon' : undefined}
              title={item.comingSoon}
            >
              <span className={styles.icon} aria-hidden="true">
                {item.icon}
              </span>
              {/* The spaces keep the link's name readable: inline spans would run together as "ReportsComing soon" */}
              <span className={styles.label}>{item.label}</span>{' '}
              {item.comingSoon ? <span className="visually-hidden">{item.comingSoon}</span> : null}{' '}
              {item.badge ? (
                <span className={styles.badge}>
                  <Badge count={item.badge.count} label={item.badge.label} />
                </span>
              ) : null}
            </UiLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
