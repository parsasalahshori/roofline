import { createBrowserRouter, createMemoryRouter, type RouteObject } from 'react-router';
import { setUnauthorizedHandler } from '../api/client.ts';
import { common } from '../copy/common.ts';
import { AcceptInvite } from '../features/auth/AcceptInvite.tsx';
import { ResetPassword } from '../features/auth/ResetPassword.tsx';
import { SignIn } from '../features/auth/SignIn.tsx';
import { VerifyEmail } from '../features/auth/VerifyEmail.tsx';
import { redirectToSignIn, RequireSession, resetSignInRedirect } from './RequireSession.tsx';

/** Stands in until the shell (Task 12) is mounted under the session route. */
function Placeholder() {
  return (
    <main>
      <h1>{common.appName}</h1>
    </main>
  );
}

const routes: RouteObject[] = [
  // Open to everyone: signing in, and the pages that links in emails open
  { path: '/sign-in', element: <SignIn /> },
  { path: '/reset', element: <ResetPassword /> },
  { path: '/verify', element: <VerifyEmail /> },
  { path: '/invite', element: <AcceptInvite /> },
  {
    // Everything else needs a session. The shell's routes become children of this one.
    element: <RequireSession />,
    children: [
      { index: true, element: <Placeholder /> },
      { path: '*', element: <Placeholder /> },
    ],
  },
];

/**
 * The app's router: in the browser's history, or, given `initialEntries` (tests), in memory.
 * It also tells the API client where to send a person whose session ends in the middle of a request.
 */
export function createAppRouter(opts?: { initialEntries?: string[] }) {
  const router = opts?.initialEntries
    ? createMemoryRouter(routes, { initialEntries: opts.initialEntries })
    : createBrowserRouter(routes);
  resetSignInRedirect();
  setUnauthorizedHandler(() => {
    redirectToSignIn(router);
  });
  return router;
}
