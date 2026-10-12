import { Dock, type DockItem } from '@roofline/ui';
import { type CSSProperties, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { useApprovals, useAttentionCount, useMe } from '../api/hooks.ts';
import { dock, WINDOW_COPY } from '../copy/dock.ts';
import { ShellBanners } from '../features/billing/ShellBanners.tsx';
import { useTodayAutoOpen } from '../features/today/useTodayAutoOpen.ts';
import { type AppKey, DOCK_APPS } from './apps.ts';
import { countedDrafts } from './countedDrafts.ts';
import { MapErrorBoundary } from './map/MapErrorBoundary.tsx';
import { BottomTabs } from './phone/BottomTabs.tsx';
import { MoreSheet } from './phone/MoreSheet.tsx';
import styles from './Shell.module.css';
import { ShellTopBar } from './topbar/ShellTopBar.tsx';
import { useIsPhone } from './useIsPhone.ts';

// The map (MapLibre, about 1 MB) loads in its own chunk, after the shell has rendered
const MapView = lazy(() => import('./map/MapView.tsx').then((m) => ({ default: m.MapView })));

/** The count bubble on an app's dock icon. Only three apps have one, and nothing is drawn at zero. */
function badgeFor(app: AppKey, count: number): DockItem['badge'] {
  if (!(count > 0)) return undefined;
  if (app === 'storm') return { count, label: dock.stormBadge(count) };
  if (app === 'estimator') return { count, label: dock.estimatorBadge(count) };
  if (app === 'agents') return { count, label: dock.agentsBadge(count) };
  return undefined;
}

/**
 * The layout every signed-in page sits in: the top bar, the map, the open window (the page's
 * outlet) and the dock. The map is the home page; a window opens over it at its own URL.
 */
export function Shell() {
  useTodayAutoOpen();
  const companyId = useMe().data?.company.id ?? 'none';
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const approvals = useApprovals();
  const attention = useAttentionCount();
  const drafts = countedDrafts(approvals.data);
  const phone = useIsPhone();
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetOpen = phone && moreOpen;
  const bannersRef = useRef<HTMLDivElement>(null);
  const [bannerHeight, setBannerHeight] = useState(0);

  // The banner slot's height moves the windows down while a banner shows. No ResizeObserver (jsdom): nothing is measured.
  useEffect(() => {
    const el = bannersRef.current;
    if (typeof ResizeObserver === 'undefined' || !el) return;
    const measure = () => setBannerHeight(Math.round(el.getBoundingClientRect().height));
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const counts: Record<AppKey, number> = {
    storm: drafts.filter((task) => task.agent === 'storm_scout').length,
    'front-desk': 0,
    estimator: drafts.filter((task) => task.agent === 'estimator').length,
    jobs: 0,
    calendar: 0,
    agents: attention.data ?? 0,
  };
  const currentApp = pathname.split('/')[1];

  const items: DockItem[] = DOCK_APPS.map((app) => ({
    key: app.key,
    label: WINDOW_COPY[app.key].title,
    href: app.href,
    icon: app.icon,
    comingSoon: app.shipped ? undefined : dock.comingSoon,
    current: currentApp === app.key,
    badge: badgeFor(app.key, counts[app.key]),
  }));

  const open = (target: { kind: 'customer' | 'job'; id: string }) => {
    void navigate((target.kind === 'customer' ? '/customers/' : '/jobs/') + encodeURIComponent(target.id));
  };

  return (
    <div className={styles.shell} style={{ '--shell-banner-height': bannerHeight + 'px' } as CSSProperties}>
      <div className={styles.topBar}>
        <ShellTopBar />
      </div>
      <div ref={bannersRef} className={styles.banners}>
        <ShellBanners />
      </div>
      <div className={styles.map}>
        {/* Keyed by company: a switch remounts the map (no old pins or pin card) and clears a failed map */}
        <MapErrorBoundary key={companyId}>
          <Suspense fallback={null}>
            <MapView onOpen={open} />
          </Suspense>
        </MapErrorBoundary>
      </div>
      <div className={styles.windows}>
        <Outlet />
      </div>
      {phone ? (
        <>
          <div className={styles.tabs}>
            <BottomTabs onMore={() => setMoreOpen(true)} moreOpen={sheetOpen} />
          </div>
          <MoreSheet open={sheetOpen} onClose={() => setMoreOpen(false)} />
        </>
      ) : (
        <div className={styles.dock}>
          <Dock label={dock.label} items={items} />
        </div>
      )}
    </div>
  );
}
