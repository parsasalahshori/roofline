import { Skeleton } from '@roofline/ui';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { canOpenBackoffice } from './access.ts';

/**
 * The back office's access check for pages that draw their own frame (the quote designer and the house-photo
 * visualizer): the same rule as BackofficePage. No back office for the company, or a role that may not use it, goes Home.
 */
export function BackofficeGuard({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <Skeleton lines={3} />;
  if (!canOpenBackoffice(me.data)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
