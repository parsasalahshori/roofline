import { TopBar, UiLink } from '@roofline/ui';
import { DemoBadge } from '../../features/demo/DemoBadge.tsx';
import { BrandMark } from '../BrandMark.tsx';
import { useIsPhone } from '../useIsPhone.ts';
import type { Brand } from '../useBrand.ts';
import { AgentsWorking } from './AgentsWorking.tsx';
import { Clock } from './Clock.tsx';
import { NotificationsBell } from './NotificationsBell.tsx';
import { OkPill } from './OkPill.tsx';
import { SearchDialog } from './SearchDialog.tsx';
import styles from './ShellTopBar.module.css';
import { UserMenu } from './UserMenu.tsx';

export type ShellTopBarProps = {
  brand: Brand;
  /** Where each page puts its breadcrumb and its own controls (Page portals into these). Stable callbacks, so they are safe as refs. */
  crumbsRef: (element: HTMLElement | null) => void;
  actionsRef: (element: HTMLElement | null) => void;
};

/**
 * The slim bar over the content: the page's breadcrumb at the left; at the right the page's own controls, the demo
 * badge, the "need your OK" pill, the agents, the bell and the clock. On a phone it is compact: the company's mark, the
 * pill, search, the bell and the initials. The person's menu and the search field live in the rail on desktop.
 */
export function ShellTopBar({ brand, crumbsRef, actionsRef }: ShellTopBarProps) {
  const phone = useIsPhone();

  if (phone) {
    return (
      <TopBar
        compact
        start={
          <>
            <UiLink href="/" className={styles.mark} aria-label={brand.name}>
              <BrandMark brand={brand} size={28} />
            </UiLink>
            <DemoBadge />
          </>
        }
        middle={<OkPill />}
        end={
          <>
            <SearchDialog />
            <NotificationsBell />
            <UserMenu />
          </>
        }
      />
    );
  }

  return (
    <TopBar
      start={<div ref={crumbsRef} className={styles.crumbs} />}
      end={
        <>
          <div ref={actionsRef} className={styles.actions} />
          <DemoBadge />
          <OkPill />
          <AgentsWorking />
          <NotificationsBell />
          <Clock />
        </>
      }
    />
  );
}
