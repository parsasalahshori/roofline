import { TopBar } from '@roofline/ui';
import { DemoBadge } from '../../features/demo/DemoBadge.tsx';
import { AgentsWorking } from './AgentsWorking.tsx';
import { Clock } from './Clock.tsx';
import { NotificationsBell } from './NotificationsBell.tsx';
import { OkPill } from './OkPill.tsx';
import styles from './ShellTopBar.module.css';

export type ShellTopBarProps = {
  /** Where each page puts its breadcrumb and its own controls (Page portals into these). Stable callbacks, so they are safe as refs. */
  crumbsRef: (element: HTMLElement | null) => void;
  actionsRef: (element: HTMLElement | null) => void;
};

/**
 * The slim bar over the content: the page's breadcrumb at the left; at the right the page's own controls, the demo
 * badge, the "need your OK" pill, the agents, the bell and the clock. The person's menu and the search field live in
 * the rail. A phone has no bar: its pages carry the search, the bell and the person in their own head (PhoneChrome).
 */
export function ShellTopBar({ crumbsRef, actionsRef }: ShellTopBarProps) {
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
