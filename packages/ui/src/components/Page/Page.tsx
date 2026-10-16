import { useContext, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../cx.ts';
import { Breadcrumb, type BreadcrumbItem } from '../Breadcrumb/Breadcrumb.tsx';
import styles from './Page.module.css';
import { PageSlotsContext } from './slots.ts';

export type PageProps = {
  /** The page's h1, and the name of its main landmark. */
  title: string;
  /** Draws no title: the content has its own header. The h1 stays for screen readers. */
  titleHidden?: boolean;
  /** One line under the title: counts, the address, what the page is. */
  subtitle?: ReactNode;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  /** A strip of numbers under the head (KPI tiles). */
  stats?: ReactNode;
  /** A row under the head: PageTabs, a Segmented control. */
  tabs?: ReactNode;
  /** The trail in the top bar. Left out, it is just the title. */
  crumbs?: ReadonlyArray<BreadcrumbItem>;
  /** The breadcrumb navigation's accessible name. */
  crumbsLabel: string;
  /** Controls for the right of the top bar. */
  barActions?: ReactNode;
  /** flow: the page scrolls. fill: the page is the height of the screen and its panels scroll (a board, a two-column work page). */
  layout?: 'flow' | 'fill';
  children: ReactNode;
  className?: string;
};

/**
 * The main area of one screen: a titled <main> with a head, optional tabs and the body. The breadcrumb goes
 * to the top bar. There is no window and no focus trap: the rail stays reachable and Tab goes where it
 * would on any page.
 */
export function Page({
  title,
  titleHidden = false,
  subtitle,
  actions,
  stats,
  tabs,
  crumbs,
  crumbsLabel,
  barActions,
  layout = 'flow',
  children,
  className,
}: PageProps) {
  const titleId = useId();
  const slots = useContext(PageSlotsContext);
  const trail = <Breadcrumb label={crumbsLabel} items={crumbs ?? [{ label: title }]} />;
  // Without a top bar to hold them (a phone, a test) the bar controls sit in the row under the head
  const inlineBarActions = barActions && !slots.actions ? barActions : null;

  return (
    <main aria-labelledby={titleId} className={cx(styles.page, className)} data-layout={layout}>
      {slots.crumbs ? createPortal(trail, slots.crumbs) : <div className={styles.inlineCrumb}>{trail}</div>}
      {barActions && slots.actions ? createPortal(barActions, slots.actions) : null}
      <div className={styles.head} data-hidden={titleHidden ? 'true' : undefined}>
        <div className={styles.titles}>
          <h1 id={titleId} className={cx(styles.title, titleHidden && 'visually-hidden')}>
            {title}
          </h1>
          {subtitle && !titleHidden ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        {actions && !titleHidden ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {stats && !titleHidden ? <div className={styles.stats}>{stats}</div> : null}
      {tabs || inlineBarActions ? (
        <div className={styles.tabs}>
          {tabs}
          {inlineBarActions}
        </div>
      ) : null}
      <div className={styles.body}>{children}</div>
    </main>
  );
}
