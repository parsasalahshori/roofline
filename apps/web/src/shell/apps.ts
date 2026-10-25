import type { IconName } from '@roofline/ui';

/** Every page the rail or the phone's More sheet can open. The key into `WINDOW_COPY` (copy/rail.ts) for its title and line. */
export type AppKey =
  | 'home'
  | 'today'
  | 'jobs'
  | 'calendar'
  | 'customers'
  | 'estimator'
  | 'approvals'
  | 'front-desk'
  | 'agents'
  | 'storm'
  | 'orders'
  | 'scans'
  | 'backoffice'
  | 'settings';

export type WindowKey = AppKey | 'notFound';

export type RailApp = { key: AppKey; href: string; icon: IconName };

/** A group in the rail. `heading` names its small title; `end` pins it to the bottom. */
export type RailLayout = { key: string; heading?: 'groupAi' | 'groupField'; end?: boolean; apps: readonly RailApp[] };

/** The rail, top to bottom: the core pages, the AI team, the field, then Settings at the foot. */
/** The Back office entry: it joins the Field group when the company has the back office on and the role may use it (ShellRail). */
export const BACKOFFICE_RAIL_APP: RailApp = { key: 'backoffice', href: '/backoffice', icon: 'layers' };

export const RAIL_LAYOUT: readonly RailLayout[] = [
  {
    key: 'core',
    apps: [
      { key: 'home', href: '/', icon: 'home' },
      { key: 'today', href: '/today', icon: 'day' },
      { key: 'jobs', href: '/jobs', icon: 'jobs' },
      { key: 'calendar', href: '/calendar', icon: 'cal' },
      { key: 'customers', href: '/customers', icon: 'users' },
      { key: 'estimator', href: '/estimator', icon: 'ruler' },
    ],
  },
  {
    key: 'ai',
    heading: 'groupAi',
    apps: [
      { key: 'approvals', href: '/approvals', icon: 'check2' },
      { key: 'front-desk', href: '/front-desk', icon: 'phone' },
      { key: 'agents', href: '/agents', icon: 'agents' },
    ],
  },
  {
    key: 'field',
    heading: 'groupField',
    apps: [
      { key: 'storm', href: '/storm', icon: 'storm' },
      { key: 'orders', href: '/estimator/windows', icon: 'factory' },
      { key: 'scans', href: '/scans', icon: 'camera' },
    ],
  },
  { key: 'end', end: true, apps: [{ key: 'settings', href: '/settings', icon: 'gear' }] },
];

/** The factory order sheet of a window measurement: /estimator/windows/:id/order. */
const ORDER_SHEET = /^\/estimator\/windows\/[^/]+\/order(\/|$)/;

/**
 * The page the address belongs to, for marking the rail. The order sheet is Factory orders, every other
 * Measure address is Measure, and an address that leads nowhere is none.
 */
export function currentApp(pathname: string): AppKey | null {
  if (pathname === '/' || pathname === '') return 'home';
  if (ORDER_SHEET.test(pathname)) return 'orders';
  const first = pathname.split('/')[1];
  switch (first) {
    case 'today':
    case 'jobs':
    case 'calendar':
    case 'customers':
    case 'approvals':
    case 'front-desk':
    case 'agents':
    case 'storm':
    case 'settings':
      return first;
    case 'scans':
      return 'scans';
    case 'backoffice':
      return 'backoffice';
    case 'estimator':
      return 'estimator';
    default:
      return null;
  }
}
