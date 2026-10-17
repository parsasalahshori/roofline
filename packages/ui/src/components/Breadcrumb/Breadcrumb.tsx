import { Fragment } from 'react';
import { UiLink } from '../../link.tsx';
import { Icon } from '../../icons.tsx';
import styles from './Breadcrumb.module.css';

export type BreadcrumbItem = {
  label: string;
  /** Without an href the item is plain text. The last item is always the current page. */
  href?: string;
};

export type BreadcrumbProps = {
  /** The navigation's accessible name. */
  label: string;
  items: ReadonlyArray<BreadcrumbItem>;
};

/** Where this page sits: links up the trail, then the page itself in ink. Rendered in the top bar by Page. */
export function Breadcrumb({ label, items }: BreadcrumbProps) {
  return (
    <nav aria-label={label} className={styles.crumb}>
      <ol className={styles.list}>
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <Fragment key={`${index}-${item.label}`}>
              {index > 0 ? (
                <li aria-hidden="true" className={styles.sep}>
                  <Icon name="chev" size={16} />
                </li>
              ) : null}
              <li className={styles.item}>
                {last || item.href === undefined ? (
                  <span aria-current={last ? 'page' : undefined} className={styles.here} data-last={last ? 'true' : undefined}>
                    {item.label}
                  </span>
                ) : (
                  <UiLink href={item.href} className={styles.link}>
                    {item.label}
                  </UiLink>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
