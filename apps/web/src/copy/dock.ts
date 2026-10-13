import type { WindowKey } from '../shell/apps.ts';

/** The dock: its name for screen readers, the note on apps that are not built yet, and the words on its count bubbles. */
export const dock = {
  label: 'Apps',
  comingSoon: 'Coming soon',
  /** The launcher tile at the start of the dock: it goes back to the map. */
  launcherLabel: 'Home',
  /** The dock's search button. Not "Search": that is the top bar button's name. */
  searchLabel: 'Quick search',
  stormBadge: (count: number) => (count === 1 ? '1 new storm plan' : `${count} new storm plans`),
  estimatorBadge: (count: number) => (count === 1 ? '1 proposal waiting' : `${count} proposals waiting`),
  frontDeskBadge: (count: number) => (count === 1 ? '1 conversation waiting' : `${count} conversations waiting`),
  agentsBadge: (count: number) => (count === 1 ? '1 task needs attention' : `${count} tasks need attention`),
} as const;

/** Each window's name and its one line under the name. The dock labels are the titles of the six apps. */
export const WINDOW_COPY: Record<WindowKey, { title: string; description: string }> = {
  storm: { title: 'Storm', description: 'Hail maps and storm plans' },
  'front-desk': { title: 'Front Desk', description: 'Answers every call and text' },
  estimator: { title: 'Estimator', description: 'Roof estimates and proposals' },
  jobs: { title: 'Jobs', description: 'Every job from lead to paid' },
  calendar: { title: 'Calendar', description: 'Inspections and installs' },
  agents: { title: 'Agents', description: 'What your agents did today' },
  approvals: { title: 'Need your OK', description: 'Plans your agents drafted, waiting for a yes' },
  today: { title: 'My day', description: 'What needs you today' },
  settings: { title: 'Settings', description: 'Your company, team and accounts' },
  customers: { title: 'Customers', description: 'Everyone you work with' },
  notFound: { title: 'Not found', description: "We couldn't find that page" },
};
