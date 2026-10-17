import { useContext, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../cx.ts';
import { Icon } from '../../icons.tsx';
import { UiLink } from '../../link.tsx';
import { Breadcrumb, type BreadcrumbItem } from '../Breadcrumb/Breadcrumb.tsx';
import styles from './Page.module.css';
import { PageSlotsContext } from './slots.ts';

export type PageProps = {
  /** The page's name: it names the main landmark, and it is the h1 unless `heading` says otherwise. */
  title: string;
  /** The visible h1 when it should read differently from the page's name ("Good morning, Dana." on Home). */
  heading?: ReactNode;
  /** A mono caps line over the title: the date on My day and Home. */
  eyebrow?: ReactNode;
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
  /** The trail in the top bar, and on a phone the way back (the item before the last). Left out, it is just the title. */
  crumbs?: ReadonlyArray<BreadcrumbItem>;
  /** The breadcrumb navigation's accessible name. */
  crumbsLabel: string;
  /** Controls for the right of the top bar; on a phone, the right of the way-back row (the Roof / Windows switch). */
  barActions?: ReactNode;
  /** flow: the page scrolls. fill: the page is the height of the screen and its panels scroll (a board, a two-column work page). */
  layout?: 'flow' | 'fill';
  children: ReactNode;
  className?: string;
};

/**
 * The main area of one screen: a titled <main> with a head, optional tabs and the body. The breadcrumb goes
 * to the top bar. There is no window and no focus trap: the rail stays reachable and Tab goes where it
 * would on any page. On a phone there is no top bar: a nested page opens with "‹ Jobs" (and its own controls at the
 * right), a top-level page has the shell's search, bell and person beside its title.
 */
export function Page({
  title,
  heading,
  eyebrow,
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
  const { phone } = slots;
  // A phone's way back: the page above this one, when the trail has one with an address
  const parent = phone && crumbs && crumbs.length > 1 ? crumbs[crumbs.length - 2] : undefined;
  // Without a top bar to hold them (a test; a phone has its own row) the bar controls sit in the row under the head
  const inlineBarActions = barActions && !slots.actions && !phone ? barActions : null;
  // On a phone the eyebrow and the subtitle leave the title's block and take rows of their own over and under the title
  // and the shell's controls, so those controls stay level with the title however long the subtitle runs
  const eyebrowNode = eyebrow && !titleHidden ? <p className={styles.eyebrow}>{eyebrow}</p> : null;
  const subtitleNode = subtitle && !titleHidden ? <p className={styles.subtitle}>{subtitle}</p> : null;
  const trailing = phone && !parent && slots.trailing && !titleHidden ? slots.trailing : null;

  return (
    <main
      aria-labelledby={heading === undefined ? titleId : undefined}
      aria-label={heading === undefined ? undefined : title}
      className={cx(styles.page, className)}
      data-layout={layout}
      data-phone={phone ? 'true' : undefined}
    >
      {phone ? (
        parent || barActions ? (
          <div className={styles.phoneBar}>
            {parent?.href !== undefined ? (
              <UiLink href={parent.href} className={styles.back}>
                <Icon name="chevl" size={18} />
                {parent.label}
              </UiLink>
            ) : (
              <span />
            )}
            {barActions ? <div className={styles.phoneBarActions}>{barActions}</div> : null}
          </div>
        ) : null
      ) : slots.crumbs ? (
        createPortal(trail, slots.crumbs)
      ) : (
        <div className={styles.inlineCrumb}>{trail}</div>
      )}
      {!phone && barActions && slots.actions ? createPortal(barActions, slots.actions) : null}
      <div className={styles.head} data-hidden={titleHidden ? 'true' : undefined} data-trailing={trailing ? 'true' : undefined}>
        {phone ? eyebrowNode : null}
        <div className={styles.titles}>
          {phone ? null : eyebrowNode}
          <h1 id={titleId} className={cx(styles.title, titleHidden && 'visually-hidden')}>
            {heading ?? title}
          </h1>
          {phone ? null : subtitleNode}
        </div>
        {phone ? subtitleNode : null}
        {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
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
