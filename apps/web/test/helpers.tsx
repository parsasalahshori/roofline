import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type { Account, TaskView } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';

/*
 * Shared by the shell's test files (Task 12). Not a test file itself: Vitest only runs *.test.*.
 * `vi.mock` does not work from here (it only applies to the file that calls it), so a test that
 * needs the map mocked calls `vi.mock` itself.
 */

export const USER = { id: 'u1', email: 'sam@example.com', name: 'Sam Roofer', emailVerified: true };
export const COMPANY: Account['company'] = { id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active' };
/** Signed in as the owner of one company. */
export const ACCOUNT: Account = { user: USER, company: COMPANY, role: 'owner', companies: [{ id: 'c1', name: 'Summit Roofing' }] };
/** The same person, who can also switch to a second company. */
export const ACCOUNT_TWO: Account = {
  ...ACCOUNT,
  companies: [
    { id: 'c1', name: 'Summit Roofing' },
    { id: 'c2', name: 'Ridge Roofing' },
  ],
};

export type Reply = { status?: number; body?: unknown };
/** `'METHOD /path?query'` (exactly as fetch is called) to what the server answers. `body` is the parsed JSON the request sent. */
export type Routes = Record<string, (request: { body: unknown; url: string }) => Reply>;

/**
 * Stands in for fetch: answers `METHOD /path` from `routes` and records every call. A request
 * nobody expects answers 500 and is listed in `unexpected`, which a test checks is empty when it ends.
 * Add or change an answer later with `api.routes['GET /api/x'] = () => ({ body: ... })`.
 */
export function stubApi(routes: Routes) {
  const calls: { key: string; url: string; body: unknown }[] = [];
  const unexpected: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? 'GET'} ${url}`;
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ key, url, body });
      const handler = routes[key];
      if (!handler) unexpected.push(key);
      const { status = 200, body: replyBody } = handler
        ? handler({ body, url })
        : { status: 500, body: { error: `Unexpected ${key}` } };
      return Promise.resolve(new Response(JSON.stringify(replyBody ?? {}), { status, headers: { 'content-type': 'application/json' } }));
    }),
  );
  return {
    routes,
    unexpected,
    /** Every call so far, in order. */
    calls,
    /** The bodies sent to `METHOD /path`, in order. */
    sent: (key: string) => calls.filter((call) => call.key === key).map((call) => call.body),
    /** How many times `METHOD /path` was called. */
    count: (key: string) => calls.filter((call) => call.key === key).length,
  };
}

/** The storm layer call the Storm window makes for the SHELL_ROUTES service area at zoom 6. */
export const STORM_LAYER_KEY = 'GET /api/map/storm-layer?bbox=-97.5,32.5,-96.5,33.5&zoom=6&days=7';
const STORM_LAYER_BODY = {
  swaths: { type: 'FeatureCollection', features: [] },
  spots: { type: 'FeatureCollection', features: [] },
  newestRunAt: null,
  stale: false,
};

/** The reads every signed-in screen makes, each answered with "nothing": spread it under a test's own routes. */
export const SHELL_ROUTES: Record<string, () => Reply> = {
  'GET /api/approvals': () => ({ body: { count: 0, tasks: [] } }),
  'GET /api/tasks/summary': () => ({ body: { working: 0 } }),
  'GET /api/tasks?status=needs_attention&limit=200': () => ({ body: { tasks: [] } }),
  'GET /api/weather': () => ({ body: { weather: null } }),
  'GET /api/setup': () => ({ body: { items: [], progress: { done: 5, total: 5 } } }),
  'POST /api/me/today-shown': () => ({ body: { show: false } }),
  'GET /api/storms': () => ({ body: { storms: [] } }),
  // The map home page's cards (features/today/Home): each answered with "nothing yet"
  'GET /api/home/signed': () => ({ body: { monthTotalCents: 0, goalCents: null, weekly: [], openPipelineCents: 0 } }),
  'GET /api/weather/outlook': () => ({ body: { outlook: null } }),
  'GET /api/agents/feed': () => ({ body: { items: [], nextCursor: null } }),
  'GET /api/company': () => ({ body: { id: 'c1', name: 'Acme Roofing', timezone: 'America/Chicago' } }),
  'GET /api/map/area': () => ({ body: { serviceArea: null, bounds: [-97.5, 32.5, -96.5, 33.5] } }),
  [STORM_LAYER_KEY]: () => ({ body: STORM_LAYER_BODY }),
  'GET /api/conversations?filter=needs_attention': () => ({ body: { items: [], nextCursor: null } }),
  // The Demo badge's probe (features/demo): a 404 means the API is not in demo mode, so no badge
  'GET /api/demo': () => ({ body: { demo: false } }),
};

/** Today's "Signed today" read, answered with nothing: spread it into a test that renders the Today window. */
export function signedTodayRoute(timeZone = 'America/Chicago'): Routes {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return { [`GET /api/proposals?status=signed&signedOn=${date}`]: () => ({ body: { proposals: [], total: 0 } }) };
}

/** The Estimator window's reads (one per status, first page): answers each with the entries of `all` of that status. */
export function proposalListRoutes(all: { status: string }[] = [], q?: string): Routes {
  const routes: Routes = {};
  for (const status of ['draft', 'ready', 'sent', 'viewed', 'signed', 'declined', 'expired']) {
    const items = all.filter((p) => p.status === status);
    routes[`GET /api/proposals?status=${status}${q === undefined ? '' : `&q=${encodeURIComponent(q)}`}`] = () => ({ body: { proposals: items, total: items.length } });
  }
  return routes;
}

/** A task as the server sends it. Pass what differs; `id` is required. */
export function makeTask(overrides: Partial<TaskView> & { id: string }): TaskView {
  return {
    agent: 'storm_scout',
    kind: 'storm_outreach',
    title: 'Storm plan for Maple Ridge',
    summary: 'Hail hit 120 homes. Text the owners and book inspections.',
    status: 'draft',
    createdAt: '2026-10-11T09:00:00.000Z',
    expiresAt: null,
    expired: false,
    minutesSaved: 0,
    rerunOfTaskId: null,
    steps: [],
    ...overrides,
  };
}

/**
 * Renders `ui` under Providers (query cache without retries, toasts, links) and a memory router
 * that shows it for every path, starting at `path`.
 */
export function renderAt(ui: ReactElement, path = '/') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

/** What the Agents dashboard reads besides the overview: the numbers, the first selected agent's detail and its feed. */
export const DASH_BODY = {
  tasksToday: 779,
  minutesThisWeek: 6600,
  hourlyRateCents: 2800,
  tasksPerHour: [1, 1, 2, 3, 5, 6, 5, 4, 3, 4, 5, 25],
  handoffsToday: 3,
  handoffs: [
    { from: 'storm_scout', to: 'front_desk', label: '504 Transom Ct', at: '2026-10-13T06:00:00.000Z' },
    { from: 'front_desk', to: 'estimator', label: '603 Cornice Dr', at: '2026-10-13T05:00:00.000Z' },
  ],
  agents: [
    { agent: 'storm_scout', minutesThisWeek: 1080, latest: { text: 'Finished: Storm plan', at: '2026-10-13T05:00:00.000Z', href: null } },
    { agent: 'estimator', minutesThisWeek: 1320, latest: null },
    { agent: 'front_desk', minutesThisWeek: 1860, latest: { text: 'Booked an inspection', at: '2026-10-13T06:30:00.000Z', href: null } },
    { agent: 'claims', minutesThisWeek: 840, latest: null },
    { agent: 'scheduler', minutesThisWeek: 540, latest: null },
    { agent: 'follow_up', minutesThisWeek: 960, latest: null },
  ],
};

export function dashDetail(agent: string) {
  return {
    card: { agent, status: 'on', finishedToday: 0, successRate: null, notApproved30d: 0, minutesThisMonth: 0, last14Days: [], waitingCount: 0 },
    period: 'week',
    minutesInPeriod: 0,
    breakdown: [],
    rules: [{ text: 'It answers every call.', links: [] }],
    paused: null,
    runNow: { kind: 'answers_calls' },
    recentTasks: [],
    hourlyRateCents: 2800,
  };
}

/** Routes the Agents dashboard calls next to GET /api/agents. Spread under a test's own routes. */
export const AGENTS_DASH_ROUTES: Routes = {
  'GET /api/company': () => ({ body: COMPANY }),
  'GET /api/agents/dashboard': () => ({ body: DASH_BODY }),
  'GET /api/agents/front_desk?period=week': () => ({ body: dashDetail('front_desk') }),
  'GET /api/agents/feed?agent=front_desk': () => ({
    body: { items: [{ id: 'e1', agent: 'front_desk', kind: 'finished', text: 'Booked an inspection', at: '2026-10-13T06:30:00.000Z', href: null }], nextCursor: null },
  }),
};

/** Where the router is: path and query string. */
export const where = (router: { state: { location: { pathname: string; search: string } } }): string =>
  router.state.location.pathname + router.state.location.search;
