import { UiLink } from '../../link.tsx';
import styles from './Tabs.module.css';

export type TabItem = {
  key: string;
  label: string;
  href: string;
  current?: boolean;
  /** A number after the label, in mono. */
  count?: number | string;
};

export type TabsProps = {
  /** The navigation's accessible name. */
  label: string;
  items: ReadonlyArray<TabItem>;
};

/** Tabs that are pages: each is a link with its own address, and the current one is marked with aria-current. */
export function Tabs({ label, items }: TabsProps) {
  return (
    <nav aria-label={label} className={styles.tabs}>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.key}>
            <UiLink href={item.href} className={styles.tab} aria-current={item.current ? 'page' : undefined}>
              {item.label}
              {item.count !== undefined ? <> <span className={styles.count}>{item.count}</span></> : null}
            </UiLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
