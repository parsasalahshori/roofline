import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { dock, WINDOW_COPY } from '../src/copy/dock.ts';
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
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: ACCOUNT }), ...overrides });
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

it('shows five bottom tabs and no dock on a phone', async () => {
  stubPhone(true);
  signedInApi();
  renderApp('/');

  const main = await MAIN();
  const links = within(main).getAllByRole('link');
  expect(links.map((link) => link.textContent)).toEqual([shell.tabMyDay, shell.tabMap, shell.tabJobs, shell.tabCalendar]);
  expect(within(main).getAllByRole('button')).toHaveLength(1);
  expect(within(main).getByRole('button', { name: shell.tabMore })).toBeInTheDocument();
  expect(within(main).getAllByRole('link').length + within(main).getAllByRole('button').length).toBe(5);
  expect(screen.queryByRole('navigation', { name: dock.label })).toBeNull();
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

it('More opens a sheet with five links', async () => {
  stubPhone(true);
  signedInApi();
  const { user } = renderApp('/');

  await user.click(within(await MAIN()).getByRole('button', { name: shell.tabMore }));
  const sheet = await screen.findByRole('dialog', { name: shell.moreTitle });
  const links = within(sheet).getAllByRole('link');
  expect(links).toHaveLength(5);
  const expected: [string, string][] = [
    [WINDOW_COPY.storm.title, '/storm'],
    [WINDOW_COPY['front-desk'].title, '/front-desk'],
    [WINDOW_COPY.estimator.title, '/estimator'],
    [WINDOW_COPY.agents.title, '/agents'],
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

it('windows are pages on a phone', async () => {
  stubPhone(true);
  signedInApi();
  renderApp('/jobs');

  const jobs = await screen.findByRole('dialog', { name: WINDOW_COPY.jobs.title });
  expect(jobs).toHaveAttribute('data-variant', 'page');
});

it('the compact top bar hides the agents line and the weather', async () => {
  stubPhone(true);
  signedInApi({
    'GET /api/approvals': () => ({ body: { count: 1, tasks: [makeTask({ id: 't1' })] } }),
  });
  renderApp('/');

  expect(await screen.findByText(shell.needYourOk(1))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: search.open })).toBeInTheDocument();
  expect(screen.queryByText(shell.agentsWorking(0))).toBeNull();
  expect(api.count('GET /api/weather')).toBe(0);
});

it('desktop keeps the dock and no bottom tabs', async () => {
  stubPhone(false);
  signedInApi();
  renderApp('/');

  expect(await screen.findByRole('navigation', { name: dock.label })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: shell.tabsLabel })).toBeNull();
});
