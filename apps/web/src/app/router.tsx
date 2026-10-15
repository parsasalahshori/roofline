import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from 'react-router';
import { setUnauthorizedHandler } from '../api/client.ts';
import { AgentRoute } from '../features/agents/AgentPage.tsx';
import { AgentsWindow } from '../features/agents/AgentsWindow.tsx';
import { FeedWindow } from '../features/agents/FeedWindow.tsx';
import { WaitingWindow } from '../features/agents/WaitingWindow.tsx';
import { ApprovalsList } from '../features/approvals/ApprovalsList.tsx';
import { AppointmentWindow } from '../features/appointments/AppointmentWindow.tsx';
import { CalendarWindow } from '../features/calendar/CalendarWindow.tsx';
import { ReviewRoute } from '../features/approvals/Review.tsx';
import { AcceptInvite } from '../features/auth/AcceptInvite.tsx';
import { ResetPassword } from '../features/auth/ResetPassword.tsx';
import { SignIn } from '../features/auth/SignIn.tsx';
import { VerifyEmail } from '../features/auth/VerifyEmail.tsx';
import { CustomersWindow } from '../features/customers/CustomersWindow.tsx';
import { CustomerWindow } from '../features/customers/CustomerWindow.tsx';
import { NewCustomer } from '../features/create/NewCustomer.tsx';
import { NewJob } from '../features/create/NewJob.tsx';
import { FrontDeskWindow } from '../features/front-desk/FrontDeskWindow.tsx';
import { ImportWizard } from '../features/imports/ImportWizard.tsx';
import { HomeownerPage } from '../features/homeowner/HomeownerPage.tsx';
import { MeasureWindow } from '../features/measure/MeasureWindow.tsx';
import { WindowsWindow } from '../features/measure/windows/WindowsWindow.tsx';
import { ProposalWindow } from '../features/proposals/ProposalWindow.tsx';
import { JobWindow } from '../features/job/JobWindow.tsx';
import { JobsWindow } from '../features/jobs/JobsWindow.tsx';
import { QuoteWindow } from '../features/quotes/QuoteWindow.tsx';
import { SignUp } from '../features/signup/SignUp.tsx';
import { Settings } from '../features/settings/Settings.tsx';
import { StormWindow } from '../features/storm/StormWindow.tsx';
import { StormDetail } from '../features/storm/StormDetail.tsx';
import { RoutesWindow } from '../features/storm/routes/RoutesWindow.tsx';
import { RouteDetail } from '../features/storm/routes/RouteDetail.tsx';
import { Today } from '../features/today/Today.tsx';
import { TextingSetup } from '../features/texting/TextingSetup.tsx';
import { AppWindow } from '../shell/AppWindow.tsx';
import { NotFoundWindow } from '../shell/NotFoundWindow.tsx';
import { Shell } from '../shell/Shell.tsx';
import { RouteError } from './RouteError.tsx';
import { redirectToSignIn, RequireSession, resetSignInRedirect } from './RequireSession.tsx';

const routes: RouteObject[] = [
  // Open to everyone: signing in, and the pages that links in emails open
  { path: '/sign-in', element: <SignIn /> },
  { path: '/sign-up', element: <SignUp /> },
  { path: '/reset', element: <ResetPassword /> },
  { path: '/verify', element: <VerifyEmail /> },
  { path: '/invite', element: <AcceptInvite /> },
  // The homeowner page needs no session and has no dock or map
  { path: '/p/:token', element: <HomeownerPage /> },
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
          { path: 'storm/routes', element: <AppWindow app="storm"><RoutesWindow /></AppWindow> },
          { path: 'storm/routes/:routeId', element: <AppWindow app="storm"><RouteDetail /></AppWindow> },
          { path: 'storm/:id', element: <AppWindow app="storm"><StormDetail /></AppWindow> },
          { path: 'front-desk/:conversationId?', element: <AppWindow app="front-desk"><FrontDeskWindow /></AppWindow> },
          { path: 'estimator', element: <AppWindow app="estimator" bare wide><MeasureWindow /></AppWindow> },
          { path: 'estimator/measure/:measurementId', element: <AppWindow app="estimator" bare wide><MeasureWindow /></AppWindow> },
          { path: 'estimator/windows', element: <AppWindow app="estimator" bare wide><WindowsWindow /></AppWindow> },
          { path: 'estimator/windows/:windowMeasurementId', element: <AppWindow app="estimator" bare wide><WindowsWindow /></AppWindow> },
          { path: 'estimator/proposals/:proposalId', element: <AppWindow app="estimator"><ProposalWindow /></AppWindow> },
          { path: 'agents', element: <AppWindow app="agents"><AgentsWindow /></AppWindow> },
          { path: 'agents/feed', element: <AppWindow app="agents"><FeedWindow /></AppWindow> },
          { path: 'agents/waiting', element: <AppWindow app="agents"><WaitingWindow /></AppWindow> },
          { path: 'agents/:agent', element: <AgentRoute /> },
          { path: 'jobs', element: <AppWindow app="jobs"><JobsWindow /></AppWindow> },
          { path: 'jobs/new', element: <AppWindow app="jobs"><NewJob /></AppWindow> },
          { path: 'jobs/:jobId', element: <AppWindow app="jobs"><JobWindow /></AppWindow> },
          { path: 'jobs/:jobId/quotes/:quoteId', element: <AppWindow app="jobs"><QuoteWindow /></AppWindow> },
          { path: 'customers', element: <AppWindow app="customers"><CustomersWindow /></AppWindow> },
          { path: 'customers/new', element: <AppWindow app="customers"><NewCustomer /></AppWindow> },
          { path: 'customers/:customerId', element: <AppWindow app="customers"><CustomerWindow /></AppWindow> },
          { path: 'calendar', element: <AppWindow app="calendar"><CalendarWindow /></AppWindow> },
          { path: 'calendar/new', element: <AppWindow app="calendar"><AppointmentWindow /></AppWindow> },
          { path: 'calendar/appointments/:appointmentId', element: <AppWindow app="calendar"><AppointmentWindow /></AppWindow> },
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
