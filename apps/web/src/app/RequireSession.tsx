import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useMe } from '../api/hooks.ts';
import { auth } from '../copy/auth.ts';
import { errors } from '../copy/errors.ts';
import styles from './RequireSession.module.css';

/** Pages a person can open without a session. A lost session does not send them from one of these to sign-in. */
const PUBLIC_PATHS = ['/sign-in', '/reset', '/verify', '/invite'];

export function signInUrl(pathname: string, search: string): string {
  return '/sign-in?next=' + encodeURIComponent(pathname + search);
}

// Several requests can come back 401 at once when a session ends. The first sends the person to
// sign in; the rest are the same news. The sign-in page clears this when it opens, ready for next time.
let redirecting = false;

/** Called by the sign-in page when it opens. */
export function resetSignInRedirect(): void {
  redirecting = false;
}

/** The part of the router that `redirectToSignIn` uses. */
type RedirectingRouter = {
  navigate: (to: string, options: { replace: boolean }) => unknown;
  state: { location: { pathname: string; search: string } };
};

/** Sends the person to sign in, bringing them back to the page they were on. Once, until the sign-in page opens. */
export function redirectToSignIn(router: RedirectingRouter): void {
  const { pathname, search } = router.state.location;
  if (redirecting || PUBLIC_PATHS.includes(pathname)) return;
  redirecting = true;
  void router.navigate(signInUrl(pathname, search), { replace: true });
}

/** Renders the page only for a signed-in person: waits for the session check, and sends everyone else to sign in. */
export function RequireSession() {
  const me = useMe();
  const location = useLocation();

  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to={signInUrl(location.pathname, location.search)} replace />;
  }
  if (me.data) return <Outlet />;

  if (me.isError) {
    return (
      <div className={styles.center} role="alert">
        <EmptyState
          title={me.error.message}
          action={
            <Button variant="primary" onClick={() => void me.refetch()}>
              {errors.tryAgain}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.center} role="status">
      <span className="visually-hidden">{auth.checkingSession}</span>
      <div className={styles.skeleton}>
        <Skeleton height="2rem" width="40%" />
        <Skeleton lines={3} />
      </div>
    </div>
  );
}
