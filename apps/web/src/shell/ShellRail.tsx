import { Icon, Rail, UiLink, type RailCount, type RailGroup } from '@roofline/ui';
import { useLocation } from 'react-router';
import { useMe } from '../api/hooks.ts';
import { canOpenBackoffice } from '../features/backoffice/access.ts';
import { rail } from '../copy/rail.ts';
import { WINDOW_COPY } from '../copy/rail.ts';
import { type AppKey, BACKOFFICE_RAIL_APP, currentApp, RAIL_LAYOUT } from './apps.ts';
import { BrandMark } from './BrandMark.tsx';
import styles from './ShellRail.module.css';
import { SearchDialog } from './topbar/SearchDialog.tsx';
import { UserMenu } from './topbar/UserMenu.tsx';
import type { Brand } from './useBrand.ts';

export type ShellRailProps = {
  brand: Brand;
  /** The count on an app's rail item, for the apps that have one. */
  counts: Partial<Record<AppKey, RailCount>>;
};

/** The shell's rail: the company, search, the apps and the person. The groups come from RAIL_LAYOUT. */
export function ShellRail({ brand, counts }: ShellRailProps) {
  const { pathname } = useLocation();
  const current = currentApp(pathname);
  const me = useMe();
  const backoffice = canOpenBackoffice(me.data);

  const groups: RailGroup[] = RAIL_LAYOUT.map((group) => ({
    key: group.key,
    title: group.heading ? rail[group.heading] : undefined,
    end: group.end,
    items: (group.key === 'field' && backoffice ? [...group.apps, BACKOFFICE_RAIL_APP] : group.apps).map((app) => ({
      key: app.key,
      label: WINDOW_COPY[app.key].title,
      href: app.href,
      icon: <Icon name={app.icon} />,
      current: current === app.key,
      count: counts[app.key],
    })),
  }));

  return (
    <Rail
      label={rail.label}
      header={
        <UiLink href="/" className={styles.company}>
          <BrandMark brand={brand} />
          <span className={styles.names}>
            <b className={styles.name}>{brand.name}</b>
            {brand.place ? <small className={styles.place}>{brand.place}</small> : null}
          </span>
        </UiLink>
      }
      search={<SearchDialog variant="field" />}
      groups={groups}
      footer={<UserMenu variant="rail" />}
    />
  );
}
