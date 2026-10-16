import { Badge, Button, Icon, UiLink, type IconName } from '@roofline/ui';
import { useLocation } from 'react-router';
import { shell } from '../../copy/shell.ts';
import styles from './BottomTabs.module.css';

type Tab = { key: string; href: string; label: string; icon: IconName };

/** The four tabs that link somewhere, in tab order. The raised Measure tab sits in the middle of them. */
const LEFT: readonly Tab[] = [
  { key: 'today', href: '/today', label: shell.tabMyDay, icon: 'day' },
  { key: 'map', href: '/', label: shell.tabMap, icon: 'map' },
];
const MEASURE: Tab = { key: 'measure', href: '/estimator', label: shell.tabMeasure, icon: 'ruler' };
const RIGHT: readonly Tab[] = [{ key: 'jobs', href: '/jobs', label: shell.tabJobs, icon: 'jobs' }];

/** The map's tab is current only at the map itself; the others are current anywhere under their first segment. */
function isCurrent(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname.split('/')[1] === href.split('/')[1];
}

/**
 * The phone's bottom tab bar: My day, Map, Measure (a raised ink button: measuring is what a rep does most), Jobs and More.
 * Counts are on My day. The shell wraps it in a fixed bar at the bottom of the screen, so this nav sets no position and
 * no z-index of its own.
 */
export function BottomTabs({ onMore, moreOpen, waiting }: { onMore: () => void; moreOpen?: boolean; waiting: number }) {
  const { pathname } = useLocation();

  function tab(item: Tab, extra?: { count?: number }) {
    const current = isCurrent(item.href, pathname);
    return (
      <UiLink
        key={item.key}
        href={item.href}
        className={styles.tab}
        aria-current={current ? 'page' : undefined}
        data-current={current ? 'true' : undefined}
        data-tab={item.key}
      >
        <span className={styles.glyph}>
          <Icon name={item.icon} size={22} />
          {/* Decoration: the "need your OK" pill in the top bar already says it, so the tab keeps the plain name */}
          {extra?.count ? (
            <span className={styles.count} aria-hidden="true">
              <Badge count={extra.count} label={shell.tabWaiting(extra.count)} tone="alert" />
            </span>
          ) : null}
        </span>
        <span className={styles.label}>{item.label}</span>
      </UiLink>
    );
  }

  return (
    <nav aria-label={shell.tabsLabel} className={styles.nav}>
      {tab(LEFT[0]!, { count: waiting })}
      {tab(LEFT[1]!)}
      {tab(MEASURE)}
      {RIGHT.map((item) => tab(item))}
      <Button
        variant="ghost"
        className={styles.tab}
        aria-haspopup="dialog"
        aria-expanded={moreOpen ?? false}
        onClick={onMore}
        data-tab="more"
      >
        <span className={styles.glyph}>
          <Icon name="dots" size={22} />
        </span>
        <span className={styles.label}>{shell.tabMore}</span>
      </Button>
    </nav>
  );
}
