import { Page, type BreadcrumbItem } from '@roofline/ui';
import type { ReactNode } from 'react';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { shell } from '../../copy/shell.ts';
import type { WindowKey } from '../../shell/apps.ts';

export type DetailPageProps = {
  /** Which app's page this is: its own title is the page's name until the thing it is about is known. */
  app: WindowKey;
  /** The page's h1: a customer's name, a job's customer. Left out while it loads, the app's own title stands in. */
  title?: string;
  /** The trail in the top bar, and on a phone the way back (the item before the last). Every detail page gives one. */
  crumbs: ReadonlyArray<BreadcrumbItem>;
  /** The line under the title: address, contact, tags. */
  subtitle?: ReactNode;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  /** Controls for the right of the top bar (on a phone, the right of the way-back row). */
  barActions?: ReactNode;
  /** A strip under the head (the stage steps of a job). */
  stats?: ReactNode;
  /** A row under the head. */
  tabs?: ReactNode;
  layout?: 'flow' | 'fill';
  children: ReactNode;
};

/**
 * A page about one thing (a customer, a job, a quote, a proposal): AppPage with the thing's own name as its title. The
 * trail names where it sits and, on a phone, is the way back. The title is the thing's name, so the h1 reads the way the
 * mockups draw it; until it is known the app's own title stands in.
 */
export function DetailPage({ app, title, children, ...rest }: DetailPageProps) {
  return (
    <Page key={app} title={title ?? WINDOW_COPY[app].title} crumbsLabel={shell.crumbsLabel} {...rest}>
      {children}
    </Page>
  );
}
