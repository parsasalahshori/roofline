import { Sheet, UiLink } from '@roofline/ui';
import { doors } from '../../copy/doors.ts';
import { WINDOW_COPY } from '../../copy/dock.ts';
import { shell } from '../../copy/shell.ts';
import { DOCK_APPS, type WindowKey } from '../apps.ts';
import { MoreIcon } from './phoneIcons.tsx';
import styles from './MoreSheet.module.css';

/** The apps the tab bar does not hold, in the order the sheet lists them. Each title is the window's own. */
const MORE_LINKS: readonly { key: WindowKey; href: string; label?: string }[] = [
  { key: 'storm', href: '/storm' },
  { key: 'storm', href: '/storm/routes', label: doors.myRoutesLink },
  { key: 'front-desk', href: '/front-desk' },
  { key: 'estimator', href: '/estimator' },
  { key: 'agents', href: '/agents' },
  { key: 'settings', href: '/settings' },
];

/**
 * The More sheet on a phone: the apps that do not fit in the tab bar. Choosing one navigates (the
 * link does that) and closes the sheet.
 */
export function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} title={shell.moreTitle} onClose={onClose} closeLabel={shell.moreClose}>
      <ul className={styles.list}>
        {MORE_LINKS.map(({ key, href, label }) => (
          <li key={href}>
            <UiLink href={href} className={styles.link} onClick={onClose}>
              <span className={styles.icon} data-app={key} aria-hidden="true">
                {DOCK_APPS.find((app) => app.key === key)?.icon ?? <MoreIcon />}
              </span>
              {label ?? WINDOW_COPY[key].title}
            </UiLink>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
