import { PageSlotsContext, type RailCount } from '@roofline/ui';
import { useMemo, useState } from 'react';
import { Outlet } from 'react-router';
import { useApprovals, useAttentionCount } from '../api/hooks.ts';
import { rail } from '../copy/rail.ts';
import { ShellBanners } from '../features/billing/ShellBanners.tsx';
import { useFrontDeskUnread } from '../features/front-desk/api.ts';
import { useTodayAutoOpen } from '../features/today/useTodayAutoOpen.ts';
import type { AppKey } from './apps.ts';
import { countedDrafts } from './countedDrafts.ts';
import { BottomTabs } from './phone/BottomTabs.tsx';
import { MoreSheet } from './phone/MoreSheet.tsx';
import { PhoneChrome } from './phone/PhoneChrome.tsx';
import styles from './Shell.module.css';
import { ShellRail } from './ShellRail.tsx';
import { ShellTopBar } from './topbar/ShellTopBar.tsx';
import { useBrand } from './useBrand.ts';
import { useIsPhone } from './useIsPhone.ts';

/** A red count for something that needs a person; nothing at zero. */
function alert(value: number, label: (count: number) => string): RailCount | undefined {
  return value > 0 ? { value, label: label(value), alert: true } : undefined;
}

/**
 * The layout every signed-in page sits in: the rail and the slim top bar (on a phone, the bottom tabs and no bar), the
 * banners and the page itself (the route's outlet). The white-label colour is applied here, once. Pages put their
 * breadcrumb and their own controls into the top bar through the slots.
 */
export function Shell() {
  useTodayAutoOpen();
  const brand = useBrand();
  const approvals = useApprovals();
  const attention = useAttentionCount();
  const frontDeskUnread = useFrontDeskUnread();
  const drafts = countedDrafts(approvals.data);
  const phone = useIsPhone();
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetOpen = phone && moreOpen;
  // State, not refs: the slots are DOM nodes Page portals into, and Page must render again once they exist
  const [crumbs, setCrumbs] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  // A phone has no top bar: its pages draw the way back and these controls themselves
  const trailing = useMemo(() => (phone ? <PhoneChrome /> : null), [phone]);
  const slots = useMemo(() => ({ crumbs, actions, phone, trailing }), [crumbs, actions, phone, trailing]);

  const counts: Partial<Record<AppKey, RailCount>> = {
    approvals: alert(drafts.length, rail.okBadge),
    'front-desk': alert(frontDeskUnread, rail.frontDeskBadge),
    estimator: alert(drafts.filter((task) => task.agent === 'estimator').length, rail.estimatorBadge),
    agents: alert(attention.data ?? 0, rail.agentsBadge),
    storm: alert(drafts.filter((task) => task.agent === 'storm_scout').length, rail.stormBadge),
  };

  return (
    <PageSlotsContext value={slots}>
      <div className={styles.shell} data-phone={phone ? 'true' : undefined}>
        {phone ? null : (
          <div className={styles.rail}>
            <ShellRail brand={brand} counts={counts} />
          </div>
        )}
        <div className={styles.main}>
          {phone ? null : (
            <div className={styles.topBar}>
              <ShellTopBar crumbsRef={setCrumbs} actionsRef={setActions} />
            </div>
          )}
          <div className={styles.banners}>
            <ShellBanners />
          </div>
          <div className={styles.content}>
            <Outlet />
          </div>
        </div>
        {phone ? (
          <>
            <div className={styles.tabs}>
              <BottomTabs onMore={() => setMoreOpen(true)} moreOpen={sheetOpen} waiting={drafts.length} />
            </div>
            <MoreSheet open={sheetOpen} onClose={() => setMoreOpen(false)} counts={counts} />
          </>
        ) : null}
      </div>
    </PageSlotsContext>
  );
}
