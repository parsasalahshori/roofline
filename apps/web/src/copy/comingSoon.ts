import type { ComingSoonKey } from '../shell/apps.ts';

/** The line a window shows while its app is not built yet. */
export const comingSoon: Record<ComingSoonKey, string> = {
  storm: 'Hail maps and storm plans are coming soon.',
  'front-desk': 'Your Front Desk, answering every call and text, is coming soon.',
  estimator: 'Roof estimates and proposals are coming soon.',
  approvals: 'The plans waiting for your OK are coming soon.',
};
