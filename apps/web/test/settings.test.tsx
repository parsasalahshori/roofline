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
import { storm } from '../src/copy/storm.ts';
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

/** A small checklist for the reads the Settings window makes; the Setup tab's own tests use the full nine steps. */
const SETUP_VIEW = {
  items: [{ key: 'company_basics', status: 'todo', comingWith: null, skippable: false, data: {} }],
  progress: { done: 0, total: 5 },
} as const;

/** The owner's billing read with no plan yet and no plans listed. */
const BILLING_BODY = {
  status: 'active',
  planKey: null,
  planName: null,
  trialEndsAt: null,
  hasPaymentMethod: false,
  canOpenPortal: false,
  periodStart: '2026-10-01T00:00:00.000Z',
  usage: [],
  plans: [],
};

/** A signed-in owner whose Settings reads answer with a company, an empty team and no billing, unless a test gives its own answers. */
function signedInApi(overrides: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
    'GET /api/team': () => ({ body: { members: [], invites: [] } }),
    // The user menu's ring reads the checklist too
    'GET /api/setup': () => ({ body: SETUP_VIEW }),
    'GET /api/billing': () => ({ body: BILLING_BODY }),
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

it('billing tab shows the card note', async () => {
  signedInApi();
  renderApp('/settings/billing');

  expect(await screen.findByText(billing.cardNote)).toBeInTheDocument();
  const nav = await tabsNav();
  expect(within(nav).getByRole('link', { name: settings.tabs.billing })).toHaveAttribute('aria-current', 'page');
});

it('connections says what is coming', async () => {
  signedInApi({
    'GET /api/calendar/connection': () => ({ body: { provider: null, status: null, accountEmail: null, calendarId: null, calendarName: null, lastSyncedAt: null, configured: { google: false, microsoft: false } } }),
    'GET /api/ads/accounts': () => ({ body: { accounts: [], managerId: null, businessId: null } }),
  });
  renderApp('/settings/connections');

  expect(await screen.findByText(connections.later)).toBeInTheDocument();
});

it('setup shows the checklist', async () => {
  signedInApi({
    'GET /api/setup': () => ({ body: SETUP_VIEW }),
  });
  renderApp('/settings/setup');

  expect(await screen.findByRole('list', { name: setup.listLabel })).toBeInTheDocument();
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

it("shows the owner's eleven tabs as links and marks the current one", async () => {
  signedInApi();
  renderApp('/settings/team');

  const nav = await tabsNav();
  const links = within(nav).getAllByRole('link');
  expect(links).toHaveLength(11);
  expect(links.map((link) => link.textContent)).toEqual([
    settings.tabs.company,
    settings.tabs.team,
    settings.tabs.prices,
    settings.tabs.schedule,
    settings.tabs.connections,
    settings.tabs.storm,
    settings.tabs.billing,
    settings.tabs.setup,
    settings.tabs['front-desk'],
    settings.tabs.agents,
    settings.tabs.profile,
  ]);
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/settings/company',
    '/settings/team',
    '/settings/prices',
    '/settings/schedule',
    '/settings/connections',
    '/settings/storm',
    '/settings/billing',
    '/settings/setup',
    '/settings/front-desk',
    '/settings/agents',
    '/settings/profile',
  ]);
  expect(links[1]).toHaveAttribute('aria-current', 'page');
  links.filter((_, i) => i !== 1).forEach((link) => expect(link).not.toHaveAttribute('aria-current'));
});

it('opens a tab from its link', async () => {
  signedInApi();
  const { router, user } = renderApp('/settings/company');

  const nav = await tabsNav();
  await user.click(within(nav).getByRole('link', { name: settings.tabs.billing }));

  await waitFor(() => expect(where(router)).toBe('/settings/billing'));
  expect(await screen.findByText(billing.cardNote)).toBeInTheDocument();
});

it('opens in a window titled Settings', async () => {
  signedInApi();
  renderApp('/settings/company');

  expect(await screen.findByRole('dialog', { name: WINDOW_COPY.settings.title })).toBeInTheDocument();
});

it('shows the Storm tab to the owner and opens it', async () => {
  signedInApi({
    'GET /api/storm/settings': () => ({
      body: {
        thresholdIn: 1,
        adBudgetCents: 25000,
        adDays: 7,
        adGoogleSharePct: 60,
        emailEnabled: true,
        smsTemplate: 'Hi {company}. Reply STOP to opt out.',
        emailSubject: 'Hail near {street}',
        emailTemplate: 'Hi {company} {company_address} {unsubscribe}',
        defaults: { smsTemplate: 'Hi {company}. Reply STOP to opt out.', emailSubject: 'Hail near {street}', emailTemplate: 'Hi' },
        photos: [],
        maxPhotos: 5,
      },
    }),
  });
  renderApp('/settings/storm');

  expect(await screen.findByLabelText(storm.settings.thresholdLabel)).toBeInTheDocument();
  const nav = await tabsNav();
  expect(within(nav).getByRole('link', { name: settings.tabs.storm })).toHaveAttribute('aria-current', 'page');
});

it('shows the Storm tab to the office', async () => {
  signedInApi({ 'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'office' } }) });
  renderApp('/settings/company');

  const nav = await tabsNav();
  expect(await within(nav).findByRole('link', { name: settings.tabs.storm })).toBeInTheDocument();
});

it('hides the Storm tab from a rep and sends the address to Company', async () => {
  signedInApi({ 'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }) });
  const { router } = renderApp('/settings/storm');

  await waitFor(() => expect(where(router)).toBe('/settings/company'));
  const nav = await tabsNav();
  expect(within(nav).queryByRole('link', { name: settings.tabs.storm })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(storm.settings.thresholdLabel)).not.toBeInTheDocument();
});

it('connections lists the ad accounts slot', async () => {
  signedInApi({ 'GET /api/ads/accounts': () => ({ body: { accounts: [], managerId: null, businessId: null } }) });
  renderApp('/settings/connections');

  expect(await screen.findByText(connections.later)).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: connections.googleAds })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: connections.meta })).toBeInTheDocument();
});
