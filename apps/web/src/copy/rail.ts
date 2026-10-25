import type { WindowKey } from '../shell/apps.ts';

/** The left rail: its name for screen readers, the group headings, the search field and the words on its count pills. */
export const rail = {
  /** The navigation's name. The end-to-end tests and screen readers look it up as "Apps". */
  label: 'Apps',
  groupAi: 'AI team',
  groupField: 'Field',
  /** The search field at the top of the rail. */
  searchField: 'Search or jump to',
  /** The key hint in the search field: command-K on a Mac, control-K elsewhere. */
  searchHint: (mac: boolean) => (mac ? '⌘K' : 'Ctrl K'),
  stormBadge: (count: number) => (count === 1 ? '1 new storm plan' : `${count} new storm plans`),
  okBadge: (count: number) => (count === 1 ? '1 plan needs your OK' : `${count} plans need your OK`),
  estimatorBadge: (count: number) => (count === 1 ? '1 proposal waiting' : `${count} proposals waiting`),
  frontDeskBadge: (count: number) => (count === 1 ? '1 conversation waiting' : `${count} conversations waiting`),
  agentsBadge: (count: number) => (count === 1 ? '1 task needs attention' : `${count} tasks need attention`),
  /** The person at the foot of the rail: what each role is called. */
  roles: { owner: 'Owner', office: 'Office', rep: 'Rep' },
} as const;

/** Each page's name and its one line under the name. The rail labels are these titles. */
export const WINDOW_COPY: Record<WindowKey, { title: string; description: string }> = {
  home: { title: 'Home', description: 'Your company at a glance' },
  storm: { title: 'Storm', description: 'Hail maps and storm plans' },
  'front-desk': { title: 'Front Desk', description: 'Answers every call and text' },
  estimator: { title: 'Measure', description: 'Roof measurements and proposals in seconds' },
  orders: { title: 'Factory orders', description: 'Window orders going to the factory' },
  scans: { title: 'Scan review', description: 'Window scans from the homeowner app, checked by a person' },
  backoffice: { title: 'Back office', description: 'Products, pricing, quotes and orders' },
  jobs: { title: 'Jobs', description: 'Every job from lead to paid' },
  calendar: { title: 'Calendar', description: 'Inspections and installs' },
  agents: { title: 'Agents', description: 'What your agents did today' },
  approvals: { title: 'Need your OK', description: 'Plans your agents drafted, waiting for a yes' },
  today: { title: 'My day', description: 'What needs you today' },
  settings: { title: 'Settings', description: 'Your company, team and accounts' },
  customers: { title: 'Customers', description: 'Everyone you work with' },
  notFound: { title: 'Not found', description: "We couldn't find that page" },
};
