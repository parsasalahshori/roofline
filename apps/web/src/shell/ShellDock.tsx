import { Badge, IconButton, UiLink, type DockItem } from '@roofline/ui';
import { dock } from '../copy/dock.ts';
import styles from './ShellDock.module.css';
import { requestSearch } from './topbar/openSearch.ts';
import { SearchIcon } from './topbar/searchIcon.tsx';

/**
 * The desktop dock: a floating tray of solid-coloured app tiles with a white line glyph, red count
 * badges, and a search button at the end. An app's name is its tooltip (shown on hover and focus) and
 * stays in the link's accessible name. The shell places the tray; this sets no position of its own.
 */
export function ShellDock({ label, items }: { label: string; items: DockItem[] }) {
  return (
    <nav aria-label={label} className={styles.tray}>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.key} className={styles.item}>
            <UiLink
              href={item.href}
              className={styles.tile}
              data-app={item.key}
              data-tip={item.label}
              data-state={item.comingSoon ? 'soon' : undefined}
              aria-current={item.current ? 'page' : undefined}
            >
              <span className={styles.glyph} aria-hidden="true">
                {item.icon}
              </span>
              {/* The spaces keep the link's name readable: inline spans would run together */}
              <span className="visually-hidden">{item.label}</span>{' '}
              {item.comingSoon ? <span className="visually-hidden">{item.comingSoon}</span> : null}{' '}
              {item.badge ? (
                <span className={styles.badge}>
                  <Badge count={item.badge.count} label={item.badge.label} />
                </span>
              ) : null}
            </UiLink>
          </li>
        ))}
        <li className={styles.item}>
          <span className={styles.rule} aria-hidden="true" />
        </li>
        <li className={styles.item}>
          <IconButton
            label={dock.searchLabel}
            icon={<SearchIcon />}
            onClick={requestSearch}
            aria-haspopup="dialog"
            className={styles.search}
            data-tip={dock.searchLabel}
          />
        </li>
      </ul>
    </nav>
  );
}
