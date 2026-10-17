import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { common } from '../src/copy/common.ts';
import { doors } from '../src/copy/doors.ts';
import { rail, WINDOW_COPY } from '../src/copy/rail.ts';
import { search } from '../src/copy/search.ts';
import { shell } from '../src/copy/shell.ts';
import { ACCOUNT, makeTask, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

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

const PHONE_QUERY = '(max-width: 767.98px)';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** Stubs matchMedia so the phone query matches when `phone` is true and no other query does. The stub is removed with the other globals after each test. */
function stubPhone(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

/** A signed-in person whose shell reads answer "nothing", unless a test gives its own answers. */
function signedInApi(overrides: Parameters<typeof stubApi>[0] = {}) {
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

const MAIN = () => screen.findByRole('navigation', { name: shell.tabsLabel });

it('shows five bottom tabs and no rail on a phone, with Measure raised in the middle', async () => {
  stubPhone(true);
  signedInApi();
  renderApp('/');

  const main = await MAIN();
  const links = within(main).getAllByRole('link');
  expect(links.map((link) => link.textContent)).toEqual([shell.tabMyDay, shell.tabMap, shell.tabMeasure, shell.tabJobs]);
  expect(within(main).getByRole('link', { name: shell.tabMeasure })).toHaveAttribute('data-tab', 'measure');
  expect(within(main).getAllByRole('button')).toHaveLength(1);
  expect(within(main).getByRole('button', { name: shell.tabMore })).toBeInTheDocument();
  expect(within(main).getAllByRole('link').length + within(main).getAllByRole('button').length).toBe(5);
  expect(screen.queryByRole('navigation', { name: rail.label })).toBeNull();
});

it('marks the current tab', async () => {
  stubPhone(true);
  signedInApi();
  const jobs = renderApp('/jobs');

  const main = await MAIN();
  expect(within(main).getByRole('link', { name: shell.tabJobs })).toHaveAttribute('aria-current', 'page');
  expect(within(main).getByRole('link', { name: shell.tabMap })).not.toHaveAttribute('aria-current');
  expect(where(jobs.router)).toBe('/jobs');

  cleanup();
  renderApp('/');
  const mainAtMap = await MAIN();
  expect(within(mainAtMap).getByRole('link', { name: shell.tabMap })).toHaveAttribute('aria-current', 'page');
  expect(within(mainAtMap).getByRole('link', { name: shell.tabJobs })).not.toHaveAttribute('aria-current');
});

it('lights More on a page that lives under it, and no other tab then', async () => {
  stubPhone(true);
  signedInApi();
  renderApp('/settings/company');

  const main = await MAIN();
  expect(within(main).getByRole('button', { name: shell.tabMore })).toHaveAttribute('data-current', 'true');
  for (const label of [shell.tabMyDay, shell.tabMap, shell.tabMeasure, shell.tabJobs]) {
    expect(within(main).getByRole('link', { name: label })).not.toHaveAttribute('aria-current');
  }

  // On a page with a tab of its own, More stays quiet
  cleanup();
  renderApp('/jobs');
  expect(within(await MAIN()).getByRole('button', { name: shell.tabMore })).not.toHaveAttribute('data-current');
});

it('More opens a sheet with the nine pages the tab bar does not hold', async () => {
  stubPhone(true);
  signedInApi();
  const { user } = renderApp('/');

  await user.click(within(await MAIN()).getByRole('button', { name: shell.tabMore }));
  const sheet = await screen.findByRole('dialog', { name: shell.moreTitle });
  const links = within(sheet).getAllByRole('link');
  expect(links).toHaveLength(9);
  const expected: [string, string][] = [
    [WINDOW_COPY.calendar.title, '/calendar'],
    [WINDOW_COPY.customers.title, '/customers'],
    [WINDOW_COPY.approvals.title, '/approvals'],
    [WINDOW_COPY['front-desk'].title, '/front-desk'],
    [WINDOW_COPY.agents.title, '/agents'],
    [WINDOW_COPY.storm.title, '/storm'],
    [doors.myRoutesLink, '/storm/routes'],
    [WINDOW_COPY.orders.title, '/estimator/windows'],
    [WINDOW_COPY.settings.title, '/settings'],
  ];
  expected.forEach(([name, href], i) => {
    expect(links[i]).toHaveAccessibleName(name);
    expect(links[i]).toHaveAttribute('href', href);
  });
});

it('choosing a More link closes the sheet and navigates', async () => {
  stubPhone(true);
  signedInApi();
  const { router, user } = renderApp('/');

  await user.click(within(await MAIN()).getByRole('button', { name: shell.tabMore }));
  const sheet = await screen.findByRole('dialog', { name: shell.moreTitle });
  await user.click(within(sheet).getByRole('link', { name: WINDOW_COPY.storm.title }));

  expect(where(router)).toBe('/storm');
  expect(screen.queryByRole('dialog', { name: shell.moreTitle })).toBeNull();
});

it('a page on a phone is the page itself: no window to close', async () => {
  stubPhone(true);
  signedInApi();
  renderApp('/jobs');

  expect(await screen.findByRole('main', { name: WINDOW_COPY.jobs.title })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: common.close })).toBeNull();
});

it('the map is its own page on a phone, and Home on a desktop', async () => {
  stubPhone(true);
  signedInApi();
  renderApp('/');
  const map = await screen.findByRole('main', { name: shell.tabMap });
  expect(within(map).getByRole('button', { name: 'job pin' })).toBeInTheDocument();
  cleanup();

  stubPhone(false);
  renderApp('/');
  expect(await screen.findByRole('main', { name: WINDOW_COPY.home.title })).toBeInTheDocument();
});

it('a phone has no top bar: the page carries search, the bell and the person beside its title', async () => {
  stubPhone(true);
  signedInApi({
    'GET /api/approvals': () => ({ body: { count: 1, tasks: [makeTask({ id: 't1' })] } }),
    'GET /api/jobs/board': () => ({ body: { columns: [], lost: { count: 0 } } }),
  });
  renderApp('/jobs');

  const main = await screen.findByRole('main', { name: WINDOW_COPY.jobs.title });
  // No bar over the page: the kit's bar marks its slots
  expect(document.querySelector('[data-slot]')).toBeNull();
  expect(within(main).getByRole('button', { name: search.open })).toBeInTheDocument();
  expect(within(main).getByRole('link', { name: shell.notificationsLabel })).toBeInTheDocument();
  expect(await within(main).findByRole('button', { name: ACCOUNT.user.name })).toBeInTheDocument();
  // The agents line and the pill stay on the desktop's bar
  expect(screen.queryByText(shell.agentsWorking(0))).toBeNull();
  expect(screen.queryByText(shell.needYourOk(1))).toBeNull();
});

it('desktop keeps the rail and no bottom tabs', async () => {
  stubPhone(false);
  signedInApi();
  renderApp('/');

  expect(await screen.findByRole('navigation', { name: rail.label })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: shell.tabsLabel })).toBeNull();
});
