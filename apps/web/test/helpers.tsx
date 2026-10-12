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

/** The reads every signed-in screen makes, each answered with "nothing": spread it under a test's own routes. */
export const SHELL_ROUTES: Record<string, () => Reply> = {
  'GET /api/approvals': () => ({ body: { count: 0, tasks: [] } }),
  'GET /api/tasks/summary': () => ({ body: { working: 0 } }),
  'GET /api/tasks?status=needs_attention&limit=200': () => ({ body: { tasks: [] } }),
  'GET /api/weather': () => ({ body: { weather: null } }),
  'GET /api/setup': () => ({ body: { items: [], progress: { done: 5, total: 5 } } }),
  'POST /api/me/today-shown': () => ({ body: { show: false } }),
};

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

/** Where the router is: path and query string. */
export const where = (router: { state: { location: { pathname: string; search: string } } }): string =>
  router.state.location.pathname + router.state.location.search;
