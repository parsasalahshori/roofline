import { Badge, Icon, Sheet, UiLink, type IconName, type RailCount } from '@roofline/ui';
import { doors } from '../../copy/doors.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { shell } from '../../copy/shell.ts';
import { DemoBadge } from '../../features/demo/DemoBadge.tsx';
import type { AppKey } from '../apps.ts';
import { MoreSetup } from './MoreSetup.tsx';
import styles from './MoreSheet.module.css';

type MoreLink = { key: AppKey; href: string; icon: IconName; label?: string };

/** The pages the tab bar does not hold, in the order the sheet lists them. Each title is the page's own. */
const MORE_LINKS: readonly MoreLink[] = [
  { key: 'calendar', href: '/calendar', icon: 'cal' },
  { key: 'customers', href: '/customers', icon: 'users' },
  { key: 'approvals', href: '/approvals', icon: 'check2' },
  { key: 'front-desk', href: '/front-desk', icon: 'phone' },
  { key: 'agents', href: '/agents', icon: 'agents' },
  { key: 'storm', href: '/storm', icon: 'storm' },
  { key: 'storm', href: '/storm/routes', icon: 'route', label: doors.myRoutesLink },
  { key: 'orders', href: '/estimator/windows', icon: 'factory' },
  { key: 'settings', href: '/settings', icon: 'gear' },
];

/**
 * The More sheet on a phone: the pages that do not fit in the tab bar, each with the count of what waits there.
 * Choosing one navigates (the link does that) and closes the sheet. The demo tools and the setup ring, which a
 * desktop keeps in the top bar and the rail, are here.
 */
export function MoreSheet({ open, onClose, counts }: { open: boolean; onClose: () => void; counts: Partial<Record<AppKey, RailCount>> }) {
  return (
    <Sheet open={open} title={shell.moreTitle} onClose={onClose} closeLabel={shell.moreClose}>
      <ul className={styles.list}>
        {MORE_LINKS.map(({ key, href, icon, label }) => {
          // The routes link has the Storm key but its own words and no count
          const count = label === undefined ? counts[key] : undefined;
          return (
            <li key={href}>
              <UiLink href={href} className={styles.link} onClick={onClose}>
                <Icon name={icon} size={22} />
                <span className={styles.name}>{label ?? WINDOW_COPY[key].title}</span>
                {count ? <Badge count={count.value} label={count.label} tone={count.alert ? 'alert' : 'neutral'} /> : null}
              </UiLink>
            </li>
          );
        })}
      </ul>
      <div className={styles.extras}>
        <MoreSetup />
        <DemoBadge />
      </div>
    </Sheet>
  );
}
