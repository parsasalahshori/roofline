import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { keys } from '../src/api/keys.ts';
import type { CompanyBody } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { approvals } from '../src/copy/approvals.ts';
import { calendar } from '../src/copy/calendar.ts';
import { common } from '../src/copy/common.ts';
import { rail, WINDOW_COPY } from '../src/copy/rail.ts';
import { search } from '../src/copy/search.ts';
import { shell } from '../src/copy/shell.ts';
import { ACCOUNT, makeTask, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need. The stand-in has two pins that open a job and a customer.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return {
    MapView: (props: { onOpen: (target: { kind: 'customer' | 'job'; id: string }) => void }) =>
      createElement(
        'div',
        { 'data-map-mock': true },
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'job', id: 'j9' }) }, 'job pin'),
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'customer', id: 'c9' }) }, 'customer pin'),
      ),
  };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A signed-in person whose shell reads answer "nothing", unless a test gives its own answers. */
function signedInApi(overrides: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    // The pipeline board (the /jobs window) reads the board and the team; both are empty here
    'GET /api/jobs/board': () => ({ body: { columns: [], lost: { count: 0 } } }),
    'GET /api/team': () => ({ body: { members: [] } }),
    // The map's job pin opens /jobs/j9, which reads its view; a 404 keeps the window out of these shell tests
    'GET /api/jobs/j9/view': () => ({ status: 404, body: { error: 'Not found' } }),
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    ...overrides,
  });
  return api;
}

function renderApp(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

/** The apps in the rail, top to bottom: the core pages, the AI team, the field, then Settings. */
const RAIL_KEYS = ['home', 'today', 'jobs', 'calendar', 'customers', 'estimator', 'approvals', 'front-desk', 'agents', 'storm', 'orders', 'scans', 'settings'] as const;
const LABELS = RAIL_KEYS.map((key) => WINDOW_COPY[key].title);

/** A rail link by its label. Its name also holds any count, so only the start of the name is matched. */
function railLink(nav: HTMLElement, label: string) {
  return within(nav).getByRole('link', { name: new RegExp('^' + label) });
}

it('shows the rail: the company, search, thirteen labeled apps and the person', async () => {
  signedInApi();
  renderApp('/');

  const nav = await screen.findByRole('navigation', { name: rail.label });
  const links = within(nav).getAllByRole('link');
  expect(links).toHaveLength(RAIL_KEYS.length);
  LABELS.forEach((label, i) => expect(links[i]).toHaveAccessibleName(new RegExp('^' + label)));
  // The company's name and place are the rail's header, the person its foot
  expect(await screen.findByText(ACCOUNT.company.name)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: ACCOUNT.user.name })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: search.open })).toBeInTheDocument();
});

it('opens each app as a full page with its own URL and no window to close', async () => {
  signedInApi();
  const { router, user } = renderApp('/');
  const nav = await screen.findByRole('navigation', { name: rail.label });

  await user.click(railLink(nav, WINDOW_COPY.storm.title));
  expect(await screen.findByRole('main', { name: WINDOW_COPY.storm.title })).toBeInTheDocument();
  expect(where(router)).toBe('/storm');

  await user.click(railLink(nav, WINDOW_COPY.jobs.title));
  expect(await screen.findByRole('main', { name: WINDOW_COPY.jobs.title })).toBeInTheDocument();
  expect(screen.getAllByRole('main')).toHaveLength(1);
  // A page is not a dialog: nothing traps focus, and there is no close button
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: common.close })).not.toBeInTheDocument();
  expect(where(router)).toBe('/jobs');
});

it('leaves Esc alone: a page is not a window', async () => {
  signedInApi();
  const { router, user } = renderApp('/jobs');
  await screen.findByRole('main', { name: WINDOW_COPY.jobs.title });

  await user.keyboard('{Escape}');
  expect(where(router)).toBe('/jobs');
});

it('puts the page trail in the top bar', async () => {
  signedInApi();
  renderApp('/jobs');

  const banner = await screen.findByRole('banner');
  const trail = await within(banner).findByRole('navigation', { name: shell.crumbsLabel });
  expect(within(trail).getByText(WINDOW_COPY.jobs.title)).toHaveAttribute('aria-current', 'page');
});

it('deep-links straight to a page', async () => {
  const company: CompanyBody = {
    id: 'c1',
    name: 'Summit Roofing',
    slug: 'summit-roofing',
    status: 'active',
    legalName: null,
    phone: null,
    email: null,
    website: null,
    addressStreet: null,
    addressCity: null,
    addressState: null,
    addressZip: null,
    timezone: 'America/Chicago',
    logoUrl: null,
    located: false,
    serviceAreaMiles: null,
  };
  const routes: Routes = {
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: company }),
    'GET /api/team': () => ({ body: { members: [], invites: [] } }),
    'POST /api/calendar/sync': () => ({ body: {} }),
  };
  api = stubApi(
    new Proxy(routes, {
      get(target, key, receiver) {
        if (typeof key === 'string' && key.startsWith('GET /api/appointments?')) return () => ({ body: { appointments: [], busy: [] } });
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  renderApp('/calendar');

  const calendarWindow = await screen.findByRole('main', { name: WINDOW_COPY.calendar.title });
  expect(within(calendarWindow).getByText(WINDOW_COPY.calendar.description)).toBeInTheDocument();
  expect(await within(calendarWindow).findByRole('button', { name: calendar.today })).toBeInTheDocument();
});

it('counts Storm and Measure drafts, Need your OK, and Agents tasks needing attention', async () => {
  signedInApi({
    'GET /api/approvals': () => ({
      body: {
        count: 3,
        tasks: [
          makeTask({ id: 't1', status: 'draft' }),
          makeTask({ id: 't2', status: 'awaiting_owner' }),
          makeTask({ id: 't3', agent: 'estimator', kind: 'estimate', title: 'Estimate for Oak Lane', summary: 'Ready to send.', status: 'draft' }),
          makeTask({ id: 't4', status: 'draft', expired: true }),
          makeTask({ id: 't5', status: 'approved' }),
        ],
      },
    }),
    'GET /api/tasks?status=needs_attention&limit=200': () => ({
      body: {
        tasks: [
          makeTask({ id: 'a1', status: 'needs_attention' }),
          makeTask({ id: 'a2', status: 'needs_attention' }),
          makeTask({ id: 'a3', status: 'needs_attention' }),
        ],
      },
    }),
  });
  renderApp('/');
  const nav = await screen.findByRole('navigation', { name: rail.label });

  expect(await within(railLink(nav, WINDOW_COPY.storm.title)).findByRole('img', { name: rail.stormBadge(2) })).toBeInTheDocument();
  expect(await within(railLink(nav, WINDOW_COPY.estimator.title)).findByRole('img', { name: rail.estimatorBadge(1) })).toBeInTheDocument();
  expect(await within(railLink(nav, WINDOW_COPY.agents.title)).findByRole('img', { name: rail.agentsBadge(3) })).toBeInTheDocument();
  expect(await within(railLink(nav, WINDOW_COPY.approvals.title)).findByRole('img', { name: rail.okBadge(3) })).toBeInTheDocument();
  for (const label of [WINDOW_COPY['front-desk'].title, WINDOW_COPY.jobs.title, WINDOW_COPY.calendar.title]) {
    expect(within(railLink(nav, label)).queryByRole('img')).not.toBeInTheDocument();
  }
});

it('Storm window offers the storm plan', async () => {
  const plan = makeTask({ id: 't1' });
  signedInApi({ 'GET /api/approvals': () => ({ body: { count: 1, tasks: [plan] } }) });
  renderApp('/storm');

  expect(await screen.findByRole('link', { name: approvals.reviewPlan })).toHaveAttribute('href', '/storm/plans/t1');
  // The plan is a card named by its title
  expect(screen.getByRole('article', { name: plan.title })).toBeInTheDocument();
});

it('Storm window offers the newest of several storm plans', async () => {
  signedInApi({
    'GET /api/approvals': () => ({
      body: {
        count: 2,
        tasks: [
          makeTask({ id: 't1', createdAt: '2026-10-10T09:00:00.000Z' }),
          makeTask({ id: 't2', createdAt: '2026-10-11T09:00:00.000Z' }),
        ],
      },
    }),
  });
  renderApp('/storm');

  expect(await screen.findByRole('link', { name: approvals.reviewPlan })).toHaveAttribute('href', '/storm/plans/t2');
});

it('Storm window offers no plan when there is none', async () => {
  signedInApi();
  const { queryClient } = renderApp('/storm');
  await screen.findByRole('main', { name: WINDOW_COPY.storm.title });

  await waitFor(() => expect(api.count('GET /api/approvals')).toBeGreaterThan(0));
  await waitFor(() => expect(queryClient.getQueryState(keys.approvals)?.status).toBe('success'));
  expect(screen.queryByRole('link', { name: approvals.reviewPlan })).not.toBeInTheDocument();
});

it('marks the open app in the rail', async () => {
  signedInApi();
  renderApp('/jobs');
  const nav = await screen.findByRole('navigation', { name: rail.label });

  expect(railLink(nav, WINDOW_COPY.jobs.title)).toHaveAttribute('aria-current', 'page');
  expect(railLink(nav, WINDOW_COPY.storm.title)).not.toHaveAttribute('aria-current');
  expect(railLink(nav, WINDOW_COPY.home.title)).not.toHaveAttribute('aria-current');
});

it('marks Home at the root', async () => {
  signedInApi();
  renderApp('/');
  const nav = await screen.findByRole('navigation', { name: rail.label });

  expect(railLink(nav, WINDOW_COPY.home.title)).toHaveAttribute('aria-current', 'page');
});

it('opens a customer or a job from a pin card', async () => {
  signedInApi({ 'GET /api/customers/c9/view': () => ({ status: 404, body: { error: 'Not found' } }) });
  const first = renderApp('/');

  await first.user.click(await screen.findByRole('button', { name: 'job pin' }));
  await waitFor(() => expect(where(first.router)).toBe('/jobs/j9'));

  // The map is on Home only, so the second pin is picked on a fresh Home
  cleanup();
  const second = renderApp('/');
  await second.user.click(await screen.findByRole('button', { name: 'customer pin' }));
  await waitFor(() => expect(where(second.router)).toBe('/customers/c9'));
});

it('opens the approvals list and the review screen as pages', async () => {
  signedInApi({ 'GET /api/approvals/t1': () => ({ status: 404, body: { error: 'Not found' } }) });
  renderApp('/approvals');
  const list = await screen.findByRole('main', { name: WINDOW_COPY.approvals.title });
  expect(await within(list).findByText(approvals.emptyTitle)).toBeInTheDocument();
  cleanup();

  renderApp('/approvals/t1');
  const review = await screen.findByRole('main', { name: WINDOW_COPY.approvals.title });
  expect(await within(review).findByText(shell.notFoundTitle)).toBeInTheDocument();
  cleanup();

  renderApp('/storm/plans/t1');
  const plan = await screen.findByRole('main', { name: WINDOW_COPY.storm.title });
  expect(await within(plan).findByText(shell.notFoundTitle)).toBeInTheDocument();
});

it('shows the Not found page for an unknown address', async () => {
  signedInApi();
  const { router } = renderApp('/nowhere');

  const notFound = await screen.findByRole('main', { name: WINDOW_COPY.notFound.title });
  expect(within(notFound).getByText(shell.notFoundTitle)).toBeInTheDocument();
  expect(within(notFound).getByRole('link', { name: shell.backHome })).toHaveAttribute('href', '/');
  expect(where(router)).toBe('/nowhere');
});

it('swaps the rail for the bottom tabs on a phone, with Measure raised in the middle', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  signedInApi();
  renderApp('/jobs');

  expect(await screen.findByRole('main', { name: WINDOW_COPY.jobs.title })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: rail.label })).not.toBeInTheDocument();
  const tabs = screen.getByRole('navigation', { name: shell.tabsLabel });
  const names = [...within(tabs).getAllByRole('link'), within(tabs).getByRole('button')].map((item) => item.textContent);
  expect(names).toEqual([shell.tabMyDay, shell.tabMap, shell.tabMeasure, shell.tabJobs, shell.tabMore]);
  expect(within(tabs).getByRole('link', { name: shell.tabMeasure })).toHaveAttribute('data-tab', 'measure');
  expect(within(tabs).getByRole('link', { name: shell.tabJobs })).toHaveAttribute('aria-current', 'page');
});
