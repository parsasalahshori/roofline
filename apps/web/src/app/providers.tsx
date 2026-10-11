import { ToastProvider, UiLinkProvider, type UiLinkProps } from '@roofline/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client.ts';
import { common } from '../copy/common.ts';

/** Try a failed read again, twice, unless the server has answered "no" (a 4xx): asking again gets the same answer. */
function shouldRetry(failureCount: number, error: Error): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetry, refetchOnWindowFocus: true } } });
}

/**
 * The kit asks for links by `href`; the router's `Link` wants `to`. Defined here, at module level,
 * and not inline in `Providers`: the kit renders the component it is given, and a new function on
 * every render would remount every link.
 */
function RouterLink({ href, ...rest }: UiLinkProps) {
  return <Link to={href} {...rest} />;
}

/** Everything the app's components expect above them, except the router. Pass `client` to use your own query cache. */
export function Providers({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider closeLabel={common.close}>
        <UiLinkProvider component={RouterLink}>{children}</UiLinkProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
