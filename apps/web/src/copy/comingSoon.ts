import type { ComingSoonKey } from '../shell/apps.ts';

/** The line a window shows while its app is not built yet. */
export const comingSoon: Record<ComingSoonKey, string> = {
  storm: 'Hail maps and storm plans are coming soon.',
  'front-desk': 'Your Front Desk, answering every call and text, is coming soon.',
  estimator: 'Roof estimates and proposals are coming soon.',
  jobs: 'Your jobs, from lead to paid, are coming soon.',
  calendar: 'Your calendar of inspections and installs is coming soon.',
  agents: 'The record of what your agents did is coming soon.',
  approvals: 'The plans waiting for your OK are coming soon.',
  customers: 'Customer pages are coming soon.',
};
