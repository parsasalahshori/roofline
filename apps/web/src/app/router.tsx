import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from 'react-router';
import { setUnauthorizedHandler } from '../api/client.ts';
import { ApprovalsList } from '../features/approvals/ApprovalsList.tsx';
import { ReviewRoute } from '../features/approvals/Review.tsx';
import { AcceptInvite } from '../features/auth/AcceptInvite.tsx';
import { ResetPassword } from '../features/auth/ResetPassword.tsx';
import { SignIn } from '../features/auth/SignIn.tsx';
import { VerifyEmail } from '../features/auth/VerifyEmail.tsx';
import { ComingSoon } from '../features/coming-soon/ComingSoon.tsx';
import { ImportWizard } from '../features/imports/ImportWizard.tsx';
import { SignUp } from '../features/signup/SignUp.tsx';
import { Settings } from '../features/settings/Settings.tsx';
import { StormWindow } from '../features/storm/StormWindow.tsx';
import { Today } from '../features/today/Today.tsx';
import { TextingSetup } from '../features/texting/TextingSetup.tsx';
import { AppWindow } from '../shell/AppWindow.tsx';
import type { ComingSoonKey } from '../shell/apps.ts';
import { NotFoundWindow } from '../shell/NotFoundWindow.tsx';
import { Shell } from '../shell/Shell.tsx';
import { RouteError } from './RouteError.tsx';
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
  { path: '/sign-up', element: <SignUp /> },
  { path: '/reset', element: <ResetPassword /> },
  { path: '/verify', element: <VerifyEmail /> },
  { path: '/invite', element: <AcceptInvite /> },
  {
    // Everything else needs a session. The shell (map, dock, windows) is the one layout under it.
    element: <RequireSession />,
    // The last resort: something outside the shell failed to render
    errorElement: <RouteError />,
    children: [
      {
        element: <Shell />,
        children: [
          {
            // A window that fails to render shows the error in the window area; the map, dock and
            // top bar stay (a pathless layout, so the error renders in the shell's outlet)
            errorElement: <RouteError variant="window" />,
            children: [
          // The map is the home page: no window
          { index: true },
          { path: 'approvals', element: <AppWindow app="approvals"><ApprovalsList /></AppWindow> },
          // The review screen draws its own window: the approvals one, or the Storm one for a storm plan
          { path: 'approvals/:taskId', element: <ReviewRoute app="approvals" /> },
          { path: 'storm', element: <AppWindow app="storm"><StormWindow /></AppWindow> },
          { path: 'storm/plans/:taskId', element: <ReviewRoute app="storm" /> },
          { path: 'storm/*', element: comingSoonWindow('storm') },
          { path: 'front-desk/*', element: comingSoonWindow('front-desk') },
          { path: 'estimator/*', element: comingSoonWindow('estimator') },
          { path: 'jobs/*', element: comingSoonWindow('jobs') },
          { path: 'calendar/*', element: comingSoonWindow('calendar') },
          { path: 'agents/*', element: comingSoonWindow('agents') },
          { path: 'customers/*', element: comingSoonWindow('customers') },
          { path: 'settings', element: <Navigate to="/settings/company" replace /> },
          { path: 'settings/setup/import', element: <AppWindow app="settings"><Settings subpage={<ImportWizard />} /></AppWindow> },
          { path: 'settings/setup/import/:importId', element: <AppWindow app="settings"><Settings subpage={<ImportWizard />} /></AppWindow> },
          { path: 'settings/setup/texting', element: <AppWindow app="settings"><Settings subpage={<TextingSetup />} /></AppWindow> },
          { path: 'settings/:tab', element: <AppWindow app="settings"><Settings /></AppWindow> },
          { path: 'today', element: <AppWindow app="today"><Today /></AppWindow> },
          // Anything else
          { path: '*', element: <NotFoundWindow /> },
            ],
          },
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
