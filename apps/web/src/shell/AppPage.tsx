import { Page, type BreadcrumbItem } from '@roofline/ui';
import type { ReactNode } from 'react';
import { WINDOW_COPY } from '../copy/rail.ts';
import { shell } from '../copy/shell.ts';
import type { WindowKey } from './apps.ts';

export type AppPageProps = {
  app: WindowKey;
  children: ReactNode;
  /** Replaces the page's one line under its title (the default is the line in WINDOW_COPY). */
  subtitle?: ReactNode;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  /** A strip of numbers under the head. */
  stats?: ReactNode;
  /** A row under the head: tabs. */
  tabs?: ReactNode;
  /** A mono caps line over the title: the date on My day. */
  eyebrow?: ReactNode;
  /** The visible title when it reads differently from the page's name (Home greets by name). The landmark keeps the name. */
  heading?: ReactNode;
  /** The trail in the top bar; left out, it is just the page's name. */
  crumbs?: ReadonlyArray<BreadcrumbItem>;
  /** Controls for the right of the top bar (the Measure switch). */
  barActions?: ReactNode;
  /** The content draws its own header: the title stays for screen readers and nothing else is drawn. */
  bare?: boolean;
  layout?: 'flow' | 'fill';
};

/**
 * One screen of the app: its title and line come from WINDOW_COPY. It is a titled <main> in the shell's content
 * column, keyed by app so opening another app replaces this one. The rail stays where it is; there is no window to close.
 */
export function AppPage({ app, children, subtitle, eyebrow, heading, actions, stats, tabs, crumbs, barActions, bare, layout }: AppPageProps) {
  const copy = WINDOW_COPY[app];
  return (
    <Page
      key={app}
      title={copy.title}
      heading={heading}
      eyebrow={eyebrow}
      titleHidden={bare}
      subtitle={subtitle ?? copy.description}
      actions={actions}
      stats={stats}
      tabs={tabs}
      crumbs={crumbs}
      crumbsLabel={shell.crumbsLabel}
      barActions={barActions}
      layout={layout ?? (bare ? 'fill' : 'flow')}
    >
      {children}
    </Page>
  );
}
