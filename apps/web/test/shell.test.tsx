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
import { dock, WINDOW_COPY } from '../src/copy/dock.ts';
import { shell } from '../src/copy/shell.ts';
import { storm } from '../src/copy/storm.ts';
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

const DOCK_KEYS = ['storm', 'front-desk', 'estimator', 'jobs', 'calendar', 'agents'] as const;
const LABELS = DOCK_KEYS.map((key) => WINDOW_COPY[key].title);

/** A dock link by its label. Its name also holds the "Coming soon" note and any badge, so only the start of the name is matched. */
function dockLink(dockNav: HTMLElement, label: string) {
  return within(dockNav).getByRole('link', { name: new RegExp('^' + label) });
}

it('shows six labeled dock apps', async () => {
  signedInApi();
  renderApp('/');

  const links = within(await screen.findByRole('navigation', { name: dock.label })).getAllByRole('link');
  expect(links).toHaveLength(6);
  LABELS.forEach((label, i) => expect(links[i]).toHaveAccessibleName(new RegExp('^' + label)));
});

it('opens each app in one centered window with its own URL', async () => {
  signedInApi();
  const { router, user } = renderApp('/');
  const dockNav = await screen.findByRole('navigation', { name: dock.label });

  await user.click(dockLink(dockNav, WINDOW_COPY.storm.title));
  const stormWindow = await screen.findByRole('dialog', { name: WINDOW_COPY.storm.title });
  expect(stormWindow).toHaveAttribute('data-variant', 'floating');
  expect(where(router)).toBe('/storm');

  await user.click(dockLink(dockNav, WINDOW_COPY.jobs.title));
  expect(await screen.findByRole('dialog', { name: WINDOW_COPY.jobs.title })).toHaveAttribute('data-variant', 'floating');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(where(router)).toBe('/jobs');
});

it('Esc and ✕ go to the map', async () => {
  signedInApi();
  const first = renderApp('/jobs');
  await screen.findByRole('dialog', { name: WINDOW_COPY.jobs.title });

  await first.user.keyboard('{Escape}');
  await waitFor(() => expect(where(first.router)).toBe('/'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  cleanup();
  const second = renderApp('/jobs');
  await second.user.click(await screen.findByRole('button', { name: common.close }));
  await waitFor(() => expect(where(second.router)).toBe('/'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('deep-links straight to a window', async () => {
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

  const calendarWindow = await screen.findByRole('dialog', { name: WINDOW_COPY.calendar.title });
  expect(within(calendarWindow).getByText(WINDOW_COPY.calendar.description)).toBeInTheDocument();
  expect(await within(calendarWindow).findByRole('button', { name: calendar.today })).toBeInTheDocument();
});

it('badges Storm with storm drafts and Agents with tasks needing attention', async () => {
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
  const dockNav = await screen.findByRole('navigation', { name: dock.label });

  expect(await within(dockLink(dockNav, WINDOW_COPY.storm.title)).findByRole('img', { name: dock.stormBadge(2) })).toBeInTheDocument();
  expect(await within(dockLink(dockNav, WINDOW_COPY.estimator.title)).findByRole('img', { name: dock.estimatorBadge(1) })).toBeInTheDocument();
  expect(await within(dockLink(dockNav, WINDOW_COPY.agents.title)).findByRole('img', { name: dock.agentsBadge(3) })).toBeInTheDocument();
  for (const label of [WINDOW_COPY['front-desk'].title, WINDOW_COPY.jobs.title, WINDOW_COPY.calendar.title]) {
    expect(within(dockLink(dockNav, label)).queryByRole('img')).not.toBeInTheDocument();
  }
});

it('Storm window offers the storm plan', async () => {
  const plan = makeTask({ id: 't1' });
  signedInApi({ 'GET /api/approvals': () => ({ body: { count: 1, tasks: [plan] } }) });
  renderApp('/storm');

  expect(await screen.findByRole('link', { name: storm.approve })).toHaveAttribute('href', '/storm/plans/t1');
  expect(screen.getByRole('heading', { level: 2, name: plan.title })).toBeInTheDocument();
  expect(screen.getByText(plan.summary ?? '')).toBeInTheDocument();
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

  expect(await screen.findByRole('link', { name: storm.approve })).toHaveAttribute('href', '/storm/plans/t2');
});

it('Storm window offers no plan when there is none', async () => {
  signedInApi();
  const { queryClient } = renderApp('/storm');
  await screen.findByRole('dialog', { name: WINDOW_COPY.storm.title });

  await waitFor(() => expect(api.count('GET /api/approvals')).toBeGreaterThan(0));
  await waitFor(() => expect(queryClient.getQueryState(keys.approvals)?.status).toBe('success'));
  expect(screen.queryByRole('link', { name: storm.approve })).not.toBeInTheDocument();
});

it('marks the open app in the dock', async () => {
  signedInApi();
  renderApp('/jobs');
  const dockNav = await screen.findByRole('navigation', { name: dock.label });

  expect(dockLink(dockNav, WINDOW_COPY.jobs.title)).toHaveAttribute('aria-current', 'page');
  expect(dockLink(dockNav, WINDOW_COPY.storm.title)).not.toHaveAttribute('aria-current');
});

it('opens a customer or a job from a pin card', async () => {
  signedInApi();
  const { router, user } = renderApp('/');

  await user.click(await screen.findByRole('button', { name: 'job pin' }));
  await waitFor(() => expect(where(router)).toBe('/jobs/j9'));

  await user.click(screen.getByRole('button', { name: 'customer pin' }));
  await waitFor(() => expect(where(router)).toBe('/customers/c9'));
});

it('opens the approvals list and the review screen in their windows', async () => {
  signedInApi({ 'GET /api/approvals/t1': () => ({ status: 404, body: { error: 'Not found' } }) });
  renderApp('/approvals');
  const list = await screen.findByRole('dialog', { name: WINDOW_COPY.approvals.title });
  expect(await within(list).findByText(approvals.emptyTitle)).toBeInTheDocument();
  cleanup();

  renderApp('/approvals/t1');
  const review = await screen.findByRole('dialog', { name: WINDOW_COPY.approvals.title });
  expect(await within(review).findByText(shell.notFoundTitle)).toBeInTheDocument();
  cleanup();

  renderApp('/storm/plans/t1');
  const plan = await screen.findByRole('dialog', { name: WINDOW_COPY.storm.title });
  expect(await within(plan).findByText(shell.notFoundTitle)).toBeInTheDocument();
});

it('shows the Not found window for an unknown address', async () => {
  signedInApi();
  const { router } = renderApp('/nowhere');

  const notFound = await screen.findByRole('dialog', { name: WINDOW_COPY.notFound.title });
  expect(within(notFound).getByText(shell.notFoundTitle)).toBeInTheDocument();
  expect(within(notFound).getByRole('link', { name: shell.backToMap })).toHaveAttribute('href', '/');
  expect(where(router)).toBe('/nowhere');
});

it('opens the window as a full page on a phone', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  signedInApi();
  renderApp('/jobs');

  expect(await screen.findByRole('dialog', { name: WINDOW_COPY.jobs.title })).toHaveAttribute('data-variant', 'page');
});
