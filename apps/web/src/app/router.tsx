import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from 'react-router';
import { setUnauthorizedHandler } from '../api/client.ts';
import { AgentRoute } from '../features/agents/AgentPage.tsx';
import { AgentsWindow } from '../features/agents/AgentsWindow.tsx';
import { FeedWindow } from '../features/agents/FeedWindow.tsx';
import { WaitingWindow } from '../features/agents/WaitingWindow.tsx';
import { ApprovalsList } from '../features/approvals/ApprovalsList.tsx';
import { AppointmentWindow } from '../features/appointments/AppointmentWindow.tsx';
import { backofficeRoutes } from '../features/backoffice/routes.tsx';
import { CalendarWindow } from '../features/calendar/CalendarWindow.tsx';
import { ReviewRoute } from '../features/approvals/Review.tsx';
import { AcceptInvite } from '../features/auth/AcceptInvite.tsx';
import { ResetPassword } from '../features/auth/ResetPassword.tsx';
import { SignIn } from '../features/auth/SignIn.tsx';
import { VerifyEmail } from '../features/auth/VerifyEmail.tsx';
import { CustomersPage } from '../features/customers/CustomersPage.tsx';
import { CustomerWindow } from '../features/customers/CustomerWindow.tsx';
import { NewCustomer } from '../features/create/NewCustomer.tsx';
import { NewJob } from '../features/create/NewJob.tsx';
import { FrontDeskWindow } from '../features/front-desk/FrontDeskWindow.tsx';
import { ImportWizard } from '../features/imports/ImportWizard.tsx';
import { HomeownerPage } from '../features/homeowner/HomeownerPage.tsx';
import { MeasureWindow } from '../features/measure/MeasureWindow.tsx';
import { WindowsWindow } from '../features/measure/windows/WindowsWindow.tsx';
import { GuttersWindow } from '../features/measure/gutters/GuttersWindow.tsx';
import { OrderWindow } from '../features/measure/windows/order/OrderWindow.tsx';
import { ProposalWindow } from '../features/proposals/ProposalWindow.tsx';
import { JobWindow } from '../features/job/JobWindow.tsx';
import { JobsPage } from '../features/jobs/JobsPage.tsx';
import { QuoteWindow } from '../features/quotes/QuoteWindow.tsx';
import { SignUp } from '../features/signup/SignUp.tsx';
import { Settings } from '../features/settings/Settings.tsx';
import { StormWindow } from '../features/storm/StormWindow.tsx';
import { StormDetail } from '../features/storm/StormDetail.tsx';
import { RoutesWindow } from '../features/storm/routes/RoutesWindow.tsx';
import { RouteDetail } from '../features/storm/routes/RouteDetail.tsx';
import { TodayPage } from '../features/today/Today.tsx';
import { TextingSetup } from '../features/texting/TextingSetup.tsx';
import { ScanQueue } from '../features/scans/ScanQueue.tsx';
import { ScanReview } from '../features/scans/ScanReview.tsx';
import { AppPage } from '../shell/AppPage.tsx';
import { HomeRoute } from '../shell/HomeRoute.tsx';
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
  // The homeowner page needs no session and has no rail or map
  { path: '/p/:token', element: <HomeownerPage /> },
  {
    // Everything else needs a session. The shell (rail, top bar, page) is the one layout under it.
    element: <RequireSession />,
    // The last resort: something outside the shell failed to render
    errorElement: <RouteError />,
    children: [
      {
        element: <Shell />,
        children: [
          {
            // A page that fails to render shows the error in the content area; the rail and
            // top bar stay (a pathless layout, so the error renders in the shell's outlet)
            errorElement: <RouteError variant="window" />,
            children: [
          // Home: on a phone, the map
          { index: true, element: <HomeRoute /> },
          { path: 'approvals', element: <AppPage app="approvals"><ApprovalsList /></AppPage> },
          // The review screen draws its own window: the approvals one, or the Storm one for a storm plan
          { path: 'approvals/:taskId', element: <ReviewRoute app="approvals" /> },
          { path: 'storm', element: <StormWindow /> },
          { path: 'storm/plans/:taskId', element: <ReviewRoute app="storm" /> },
          { path: 'storm/routes', element: <RoutesWindow /> },
          { path: 'storm/routes/:routeId', element: <RouteDetail /> },
          { path: 'storm/:id', element: <StormDetail /> },
          { path: 'front-desk/:conversationId?', element: <FrontDeskWindow /> },
          { path: 'estimator', element: <MeasureWindow /> },
          { path: 'estimator/measure/:measurementId', element: <MeasureWindow /> },
          { path: 'estimator/measure/:measurementId/gutters', element: <GuttersWindow /> },
          { path: 'estimator/windows', element: <WindowsWindow /> },
          { path: 'estimator/windows/:windowMeasurementId', element: <WindowsWindow /> },
          { path: 'estimator/windows/:windowMeasurementId/order', element: <OrderWindow /> },
          { path: 'estimator/proposals/:proposalId', element: <ProposalWindow /> },
          { path: 'scans', element: <ScanQueue /> },
          { path: 'scans/:scanId', element: <ScanReview /> },
          { path: 'agents', element: <AppPage app="agents"><AgentsWindow /></AppPage> },
          { path: 'agents/feed', element: <AppPage app="agents"><FeedWindow /></AppPage> },
          { path: 'agents/waiting', element: <AppPage app="agents"><WaitingWindow /></AppPage> },
          { path: 'agents/:agent', element: <AgentRoute /> },
          { path: 'jobs', element: <JobsPage /> },
          { path: 'jobs/new', element: <NewJob /> },
          { path: 'jobs/:jobId', element: <JobWindow /> },
          { path: 'jobs/:jobId/quotes/:quoteId', element: <QuoteWindow /> },
          { path: 'customers', element: <CustomersPage /> },
          { path: 'customers/new', element: <NewCustomer /> },
          { path: 'customers/:customerId', element: <CustomerWindow /> },
          { path: 'calendar', element: <CalendarWindow /> },
          { path: 'calendar/new', element: <AppointmentWindow /> },
          { path: 'calendar/appointments/:appointmentId', element: <AppointmentWindow /> },
          { path: 'settings', element: <Navigate to="/settings/company" replace /> },
          // Settings draws its own page (title, tabs, the way back from a screen under Setup)
          { path: 'settings/setup/import', element: <Settings subpage={<ImportWizard />} subpageKey="import" /> },
          { path: 'settings/setup/import/:importId', element: <Settings subpage={<ImportWizard />} subpageKey="import" /> },
          { path: 'settings/setup/texting', element: <Settings subpage={<TextingSetup />} subpageKey="texting" /> },
          { path: 'settings/:tab', element: <Settings /> },
          { path: 'today', element: <TodayPage /> },
          ...backofficeRoutes,
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
