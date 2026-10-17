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
 * every render would remount every link. Links to other sites and to the phone's apps are plain anchors. Download links and links to /api/ skip client-side navigation (the
 * router's `Link` ignores `download`, and /api/ paths are server routes such as the calendar connect redirect).
 */
function RouterLink({ href, ...rest }: UiLinkProps) {
  // A link to another site, or to the phone's own apps (tel:, sms:, mailto:), is a plain anchor: the router has nothing to do with it
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return <a href={href} {...rest} />;
  const isDownload = rest.download !== undefined && rest.download !== false;
  // The API is served by the server, not the router: a link to it (a file, an OAuth sign-in redirect) must be a full page load.
  const isApi = href.startsWith('/api/');
  return <Link to={href} reloadDocument={isDownload || isApi} {...rest} />;
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
