import type { ReactNode } from 'react';
import { UiLink } from '../../link.tsx';
import { Badge } from '../Badge/Badge.tsx';
import styles from './Rail.module.css';

export type RailCount = {
  value: number;
  /** What the count means, for example "2 conversations waiting". Its accessible name. */
  label: string;
  /** Red, for things that need a person. Without it the count is a quiet pill. */
  alert?: boolean;
};

export type RailItem = {
  key: string;
  /** Always in the link's name, even where the rail shows icons only. */
  label: string;
  href: string;
  icon: ReactNode;
  current?: boolean;
  count?: RailCount;
  /** A short word instead of a count: "New". */
  tag?: string;
};

export type RailGroup = {
  key: string;
  /** The small mono heading over the group. Left out, the group has none. */
  title?: string;
  items: ReadonlyArray<RailItem>;
  /** Pins the group to the bottom of the rail (Settings). */
  end?: boolean;
};

export type RailProps = {
  /** The navigation's accessible name. */
  label: string;
  /** The company block at the top: mark, name, place. */
  header: ReactNode;
  /** The search field under it. */
  search?: ReactNode;
  groups: ReadonlyArray<RailGroup>;
  /** The signed-in person at the bottom. */
  footer?: ReactNode;
};

/**
 * The left rail: the company, search, the apps in groups, Settings and the person. 236px wide, and 64px
 * (icons only, counts on the corner) below 1100px; every label stays in the accessibility tree either way.
 * The shell places it; it sets no position of its own.
 */
export function Rail({ label, header, search, groups, footer }: RailProps) {
  return (
    <aside className={styles.rail}>
      <div className={styles.header}>{header}</div>
      {search ? <div className={styles.search}>{search}</div> : null}
      <nav aria-label={label} className={styles.nav}>
        {groups.map((group) => (
          <div key={group.key} role="group" aria-label={group.title} className={styles.group} data-end={group.end ? 'true' : undefined}>
            {group.title ? (
              <p aria-hidden="true" className={styles.groupTitle}>
                {group.title}
              </p>
            ) : null}
            <ul className={styles.list}>
              {group.items.map((item) => (
                <li key={item.key}>
                  <UiLink href={item.href} className={styles.item} aria-current={item.current ? 'page' : undefined} data-app={item.key}>
                    <span className={styles.icon} aria-hidden="true">
                      {item.icon}
                    </span>
                    {/* The spaces keep the link's name readable: inline spans would run together */}
                    <span className={styles.text}>{item.label}</span>{' '}
                    {item.count ? (
                      <span className={styles.count}>
                        <Badge count={item.count.value} label={item.count.label} tone={item.count.alert ? 'alert' : 'neutral'} />
                      </span>
                    ) : item.tag ? (
                      <span className={styles.tag}>{item.tag}</span>
                    ) : null}
                  </UiLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </aside>
  );
}
