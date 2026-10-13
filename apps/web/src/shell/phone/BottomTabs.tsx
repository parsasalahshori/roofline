import { Button } from '@roofline/ui';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { shell } from '../../copy/shell.ts';
import { CalendarIcon, JobsIcon } from '../dockIcons.tsx';
import styles from './BottomTabs.module.css';
import { MapIcon, MoreIcon, MyDayIcon } from './phoneIcons.tsx';

type Tab = { key: string; href: string; label: string; icon: ReactNode };

/** The four tabs that link somewhere, in tab order. */
const TABS: readonly Tab[] = [
  { key: 'today', href: '/today', label: shell.tabMyDay, icon: <MyDayIcon /> },
  { key: 'map', href: '/', label: shell.tabMap, icon: <MapIcon /> },
  { key: 'jobs', href: '/jobs', label: shell.tabJobs, icon: <JobsIcon /> },
  { key: 'calendar', href: '/calendar', label: shell.tabCalendar, icon: <CalendarIcon /> },
];

/** The map's tab is current only at the map itself; the others are current anywhere under their first segment. */
function isCurrent(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname.split('/')[1] === href.split('/')[1];
}

/**
 * The phone's bottom tab bar in the dock's tile style: My day, Map, Jobs, Calendar and More. The shell wraps it in a fixed
 * bar at the bottom of the screen, so this nav sets no position and no z-index of its own.
 */
export function BottomTabs({ onMore, moreOpen }: { onMore: () => void; moreOpen?: boolean }) {
  const { pathname } = useLocation();
  return (
    <nav aria-label={shell.tabsLabel} className={styles.nav}>
      {TABS.map((tab) => {
        const current = isCurrent(tab.href, pathname);
        return (
          <Button
            key={tab.key}
            variant="ghost"
            href={tab.href}
            className={styles.tab}
            aria-current={current ? 'page' : undefined}
            data-current={current ? 'true' : undefined}
            data-tab={tab.key}
          >
            <span className={styles.tile}>
              <span className={styles.icon}>{tab.icon}</span>
            </span>
            <span className={styles.label}>{tab.label}</span>
          </Button>
        );
      })}
      <Button
        variant="ghost"
        className={styles.tab}
        aria-haspopup="dialog"
        aria-expanded={moreOpen ?? false}
        onClick={onMore}
        data-tab="more"
      >
        <span className={styles.tile}>
          <span className={styles.icon}>
            <MoreIcon />
          </span>
        </span>
        <span className={styles.label}>{shell.tabMore}</span>
      </Button>
    </nav>
  );
}
