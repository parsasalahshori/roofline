import { EmptyState } from '@roofline/ui';
import { comingSoon } from '../../copy/comingSoon.ts';
import type { ComingSoonKey } from '../../shell/apps.ts';

/** The line a window shows while its app is not built yet. The task that builds the app replaces it. */
export function ComingSoon({ app }: { app: ComingSoonKey }) {
  return <EmptyState title={comingSoon[app]} />;
}
