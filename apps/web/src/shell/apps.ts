import { createElement, type ReactNode } from 'react';
import { AgentsIcon, CalendarIcon, EstimatorIcon, FrontDeskIcon, JobsIcon, StormIcon } from './dockIcons.tsx';

/** The six apps in the dock, in dock order: storm, front-desk, estimator, jobs, calendar, agents. */
export type AppKey = 'storm' | 'front-desk' | 'estimator' | 'jobs' | 'calendar' | 'agents';

/** Every window there is. The key into `WINDOW_COPY` (copy/dock.ts) for the window's title and description. */
export type WindowKey = AppKey | 'today' | 'approvals' | 'settings' | 'customers' | 'notFound';

/** The windows that show a "coming soon" line (copy/comingSoon.ts) for now. Jobs, Calendar and Customers have real windows. */
export type ComingSoonKey = 'estimator' | 'approvals';

/** One app in the dock. `shipped` is true once the app has its real windows; a shipped app shows no "Coming soon" note. */
export type DockApp = { key: AppKey; href: string; icon: ReactNode; shipped: boolean };

/** The dock's apps, in dock order. Filled in by the shell package (Task 12, package A). */
export const DOCK_APPS: readonly DockApp[] = [
  { key: 'storm', href: '/storm', icon: createElement(StormIcon), shipped: true },
  { key: 'front-desk', href: '/front-desk', icon: createElement(FrontDeskIcon), shipped: true },
  { key: 'estimator', href: '/estimator', icon: createElement(EstimatorIcon), shipped: true },
  { key: 'jobs', href: '/jobs', icon: createElement(JobsIcon), shipped: true },
  { key: 'calendar', href: '/calendar', icon: createElement(CalendarIcon), shipped: true },
  { key: 'agents', href: '/agents', icon: createElement(AgentsIcon), shipped: true },
];
