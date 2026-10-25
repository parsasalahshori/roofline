import { Skeleton, UiLink, type BreadcrumbItem } from '@roofline/ui';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { backoffice } from '../../copy/backoffice.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { canEditBackoffice, canOpenBackoffice } from './access.ts';
import './apple.css';

export type BackofficeTab = 'home' | 'products' | 'orders' | 'settings';

const TAB_HREF: Record<BackofficeTab, string> = { home: '/backoffice', products: '/backoffice/products', orders: '/backoffice/orders', settings: '/backoffice/settings' };

export type BackofficePageProps = {
  /** Which section is open. */
  tab: BackofficeTab;
  /** The large title; left out, the section's name. */
  title?: string;
  subtitle?: ReactNode;
  /** The toolbar at the right of the title. */
  actions?: ReactNode;
  crumbs?: ReadonlyArray<BreadcrumbItem>;
  /** Hides the section switch (a detail page has its own way back). */
  hideSections?: boolean;
  children: (access: { canEdit: boolean }) => ReactNode;
};

/**
 * The back office page frame, drawn in the Apple look: a large title with a toolbar, a segmented switch between the
 * sections, and the page. It also guards: a person whose company has no back office, or whose role may not use it,
 * goes Home; while we do not yet know who they are, the page waits.
 */
export function BackofficePage({ tab, title, subtitle, actions, crumbs, hideSections, children }: BackofficePageProps) {
  const me = useMe();
  if (me.isPending) {
    return (
      <AppPage app="backoffice" bare layout="flow">
        <div className="bo-apple">
          <Skeleton lines={3} />
        </div>
      </AppPage>
    );
  }
  if (!canOpenBackoffice(me.data)) return <Navigate to="/" replace />;
  const canEdit = canEditBackoffice(me.data?.role);
  // The messages and stuck days are the office's; a rep has no Settings section
  if (tab === 'settings' && !canEdit) return <Navigate to="/backoffice" replace />;
  const sections: BackofficeTab[] = canEdit ? ['home', 'products', 'orders', 'settings'] : ['home', 'products', 'orders'];
  return (
    <AppPage app="backoffice" bare layout="flow" crumbs={crumbs}>
      <div className="bo-apple">
        <header className="bo-head">
          <div>
            <h2 className="bo-large">{title ?? backoffice.titles[tab]}</h2>
            <p className="bo-foot">{subtitle ?? backoffice.descriptions[tab]}</p>
          </div>
          {actions ? <div className="bo-toolbar">{actions}</div> : null}
        </header>
        {hideSections ? null : (
          <nav className="bo-seg" aria-label={backoffice.tabsLabel}>
            {sections.map((key) => (
              <UiLink key={key} href={TAB_HREF[key]} aria-current={key === tab ? 'page' : undefined}>
                {backoffice.tabs[key]}
              </UiLink>
            ))}
          </nav>
        )}
        {children({ canEdit })}
      </div>
    </AppPage>
  );
}
