import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { billing } from '../src/copy/billing.ts';
import { connections } from '../src/copy/connections.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import { setup } from '../src/copy/setup.ts';
import { settings } from '../src/copy/settings.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

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

/** The company as the server sends it, for every test that opens the Company tab. */
const COMPANY_BODY = {
  id: 'c1',
  name: 'Summit Roofing',
  slug: 'summit-roofing',
  status: 'active',
  legalName: null,
  phone: '+14025551234',
  email: 'office@summit.example',
  website: 'https://summit.example',
  addressStreet: '12 Main St',
  addressCity: 'Omaha',
  addressState: 'NE',
  addressZip: '68102',
  timezone: 'America/Chicago',
  logoUrl: null,
};

/** A signed-in owner whose Settings reads answer with a company and an empty team, unless a test gives its own answers. */
function signedInApi(overrides: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    'GET /api/team': () => ({ body: { members: [], invites: [] } }),
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

/** The row of tab links in the Settings window. Its name is the one from the copy, so the top bar's links are not matched. */
const tabsNav = () => screen.findByRole('navigation', { name: settings.tabsLabel });

it('later tabs say what is coming', async () => {
  signedInApi();
  renderApp('/settings/billing');

  expect(await screen.findByText(billing.later)).toBeInTheDocument();
  const nav = await tabsNav();
  expect(within(nav).getByRole('link', { name: settings.tabs.billing })).toHaveAttribute('aria-current', 'page');
});

it('connections says what is coming', async () => {
  signedInApi();
  renderApp('/settings/connections');

  expect(await screen.findByText(connections.later)).toBeInTheDocument();
});

it('setup says what is coming', async () => {
  signedInApi();
  renderApp('/settings/setup');

  expect(await screen.findByText(setup.later)).toBeInTheDocument();
});

it('unknown tab goes to company', async () => {
  signedInApi();
  const { router } = renderApp('/settings/nope');

  await waitFor(() => expect(where(router)).toBe('/settings/company'));
  const nav = await tabsNav();
  expect(within(nav).getByRole('link', { name: settings.tabs.company })).toHaveAttribute('aria-current', 'page');
});

it('settings goes to company', async () => {
  signedInApi();
  const { router } = renderApp('/settings');

  await waitFor(() => expect(where(router)).toBe('/settings/company'));
});

it('shows the five tabs as links and marks the current one', async () => {
  signedInApi();
  renderApp('/settings/team');

  const nav = await tabsNav();
  const links = within(nav).getAllByRole('link');
  expect(links).toHaveLength(5);
  expect(links.map((link) => link.textContent)).toEqual([
    settings.tabs.company,
    settings.tabs.team,
    settings.tabs.connections,
    settings.tabs.billing,
    settings.tabs.setup,
  ]);
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/settings/company',
    '/settings/team',
    '/settings/connections',
    '/settings/billing',
    '/settings/setup',
  ]);
  expect(links[1]).toHaveAttribute('aria-current', 'page');
  for (const link of [links[0], links[2], links[3], links[4]]) {
    expect(link).not.toHaveAttribute('aria-current');
  }
});

it('opens a tab from its link', async () => {
  signedInApi();
  const { router, user } = renderApp('/settings/company');

  const nav = await tabsNav();
  await user.click(within(nav).getByRole('link', { name: settings.tabs.billing }));

  await waitFor(() => expect(where(router)).toBe('/settings/billing'));
  expect(await screen.findByText(billing.later)).toBeInTheDocument();
});

it('opens in a window titled Settings', async () => {
  signedInApi();
  renderApp('/settings/company');

  expect(await screen.findByRole('dialog', { name: WINDOW_COPY.settings.title })).toBeInTheDocument();
});
