import { createBrowserRouter, createMemoryRouter, type RouteObject } from 'react-router';
import { setUnauthorizedHandler } from '../api/client.ts';
import { AcceptInvite } from '../features/auth/AcceptInvite.tsx';
import { ResetPassword } from '../features/auth/ResetPassword.tsx';
import { SignIn } from '../features/auth/SignIn.tsx';
import { VerifyEmail } from '../features/auth/VerifyEmail.tsx';
import { ComingSoon } from '../features/coming-soon/ComingSoon.tsx';
import { StormWindow } from '../features/storm/StormWindow.tsx';
import { AppWindow } from '../shell/AppWindow.tsx';
import type { ComingSoonKey } from '../shell/apps.ts';
import { NotFoundWindow } from '../shell/NotFoundWindow.tsx';
import { Shell } from '../shell/Shell.tsx';
import { redirectToSignIn, RequireSession, resetSignInRedirect } from './RequireSession.tsx';

/** A window for an app that is not built yet: its title, and the line that says so. */
function comingSoonWindow(app: ComingSoonKey) {
  return (
    <AppWindow app={app}>
      <ComingSoon app={app} />
    </AppWindow>
  );
}

const routes: RouteObject[] = [
  // Open to everyone: signing in, and the pages that links in emails open
  { path: '/sign-in', element: <SignIn /> },
  { path: '/reset', element: <ResetPassword /> },
  { path: '/verify', element: <VerifyEmail /> },
  { path: '/invite', element: <AcceptInvite /> },
  {
    // Everything else needs a session. The shell (map, dock, windows) is the one layout under it.
    element: <RequireSession />,
    children: [
      {
        element: <Shell />,
        children: [
          // The map is the home page: no window
          { index: true },
          // Task 14 replaces the two approval windows
          { path: 'approvals', element: comingSoonWindow('approvals') },
          { path: 'approvals/:taskId', element: comingSoonWindow('approvals') },
          { path: 'storm', element: <AppWindow app="storm"><StormWindow /></AppWindow> },
          // Task 14 replaces the storm plan window
          { path: 'storm/plans/:taskId', element: comingSoonWindow('storm') },
          { path: 'storm/*', element: comingSoonWindow('storm') },
          { path: 'front-desk/*', element: comingSoonWindow('front-desk') },
          { path: 'estimator/*', element: comingSoonWindow('estimator') },
          { path: 'jobs/*', element: comingSoonWindow('jobs') },
          { path: 'calendar/*', element: comingSoonWindow('calendar') },
          { path: 'agents/*', element: comingSoonWindow('agents') },
          { path: 'customers/*', element: comingSoonWindow('customers') },
          // Tasks 15 and 16 add today and settings; until then they show this
          { path: '*', element: <NotFoundWindow /> },
        ],
      },
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
