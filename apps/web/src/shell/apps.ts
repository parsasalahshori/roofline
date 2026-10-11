import { createElement, type ReactNode } from 'react';
import { AgentsIcon, CalendarIcon, EstimatorIcon, FrontDeskIcon, JobsIcon, StormIcon } from './dockIcons.tsx';

/** The six apps in the dock, in dock order: storm, front-desk, estimator, jobs, calendar, agents. */
export type AppKey = 'storm' | 'front-desk' | 'estimator' | 'jobs' | 'calendar' | 'agents';

/** Every window there is. The key into `WINDOW_COPY` (copy/dock.ts) for the window's title and description. */
export type WindowKey = AppKey | 'today' | 'approvals' | 'settings' | 'customers' | 'notFound';

/** The windows that show a "coming soon" line (copy/comingSoon.ts) for now. */
export type ComingSoonKey = AppKey | 'approvals' | 'customers';

export type DockApp = { key: AppKey; href: string; icon: ReactNode; shipped: false };

/** The dock's apps, in dock order. Filled in by the shell package (Task 12, package A). */
export const DOCK_APPS: readonly DockApp[] = [
  { key: 'storm', href: '/storm', icon: createElement(StormIcon), shipped: false },
  { key: 'front-desk', href: '/front-desk', icon: createElement(FrontDeskIcon), shipped: false },
  { key: 'estimator', href: '/estimator', icon: createElement(EstimatorIcon), shipped: false },
  { key: 'jobs', href: '/jobs', icon: createElement(JobsIcon), shipped: false },
  { key: 'calendar', href: '/calendar', icon: createElement(CalendarIcon), shipped: false },
  { key: 'agents', href: '/agents', icon: createElement(AgentsIcon), shipped: false },
];
