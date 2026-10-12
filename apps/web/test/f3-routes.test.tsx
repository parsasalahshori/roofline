import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import type { ImportView } from '@roofline/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { auth } from '../src/copy/auth.ts';
import { billing } from '../src/copy/billing.ts';
import { connections } from '../src/copy/connections.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import { importCopy } from '../src/copy/import.ts';
import { settings } from '../src/copy/settings.ts';
import { setup } from '../src/copy/setup.ts';
import { texting } from '../src/copy/texting.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

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

/** A freshly uploaded import, enough for the mapping step to show. */
function importView(id: string): ImportView {
  const none = { noName: 0, noContact: 0, badPhone: 0, duplicate: 0 };
  return {
    id,
    fileName: 'c.csv',
    status: 'uploaded',
    headers: ['Name', 'Phone'],
    mapping: { name: 0, phone: 1 },
    rowCount: 3,
    counts: {
      total: 3,
      new: 2,
      updated: 1,
      skipped: 0,
      skippedBy: none,
      consent: { attested: 0, express: 0, unchanged: 0, optedOutKept: 0 },
      jobs: 0,
      processed: 0,
      located: 0,
      notLocated: 0,
    },
    preview: [],
    progress: { processed: 0, total: 3 },
    consentAttested: false,
    startedAt: null,
    finishedAt: null,
    errorPlain: null,
    skippedDownloadUrl: null,
  };
}

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

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

/** A small checklist for the reads the shell makes; the Setup tab's own tests use the full nine steps. */
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

/** A signed-in owner, with the shell's reads answered as "nothing" and no billing plan yet. */
function signedInApi(overrides: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    // The user menu's ring reads the checklist too
    'GET /api/setup': () => ({ body: SETUP_VIEW }),
    'GET /api/billing': () => ({ body: BILLING_BODY }),
    ...overrides,
  });
  return api;
}

/** The Settings window, found by its title from the copy. */
const settingsWindow = () => screen.findByRole('dialog', { name: WINDOW_COPY.settings.title });

/** The row of tab links in the Settings window. */
const tabsNav = () => screen.findByRole('navigation', { name: settings.tabsLabel });

it('import line shows inside the Settings window with the Setup tab current', async () => {
  signedInApi();
  renderApp('/settings/setup/import');

  const dialog = await settingsWindow();
  expect(await within(dialog).findByLabelText(importCopy.uploadLabel)).toBeInTheDocument();
  const nav = await tabsNav();
  expect(within(nav).getByRole('link', { name: settings.tabs.setup })).toHaveAttribute('aria-current', 'page');
});

it('import line shows for a single import inside the Settings window with the Setup tab current', async () => {
  signedInApi();
  api.routes['GET /api/imports/abc?attested=false'] = () => ({ body: importView('abc') });
  renderApp('/settings/setup/import/abc');

  const dialog = await settingsWindow();
  expect(await within(dialog).findByText(importCopy.mappingTitle)).toBeInTheDocument();
  const nav = await tabsNav();
  expect(within(nav).getByRole('link', { name: settings.tabs.setup })).toHaveAttribute('aria-current', 'page');
});

it('texting form shows inside the Settings window with the Setup tab current', async () => {
  signedInApi();
  api.routes['GET /api/texting'] = () => ({
    body: {
      state: 'not_started',
      reason: null,
      rejectedFields: [],
      brand: null,
      defaults: { legalName: 'Summit Roofing LLC', website: '' },
      submittedAt: null,
      approvedAt: null,
      number: null,
      needsPaymentMethod: false,
      needsVerifiedEmail: false,
      hostedPolicyUrls: { privacy: 'https://summit.example.test/privacy', terms: 'https://summit.example.test/terms' },
    },
  });
  renderApp('/settings/setup/texting');

  const dialog = await settingsWindow();
  expect(await within(dialog).findByRole('button', { name: texting.send })).toBeInTheDocument();
  const nav = await tabsNav();
  expect(within(nav).getByRole('link', { name: settings.tabs.setup })).toHaveAttribute('aria-current', 'page');
});

it('billing says there is no plan yet', async () => {
  signedInApi();
  renderApp('/settings/billing');

  expect(await screen.findByText(billing.noPlan)).toBeInTheDocument();
});

it('setup shows the checklist', async () => {
  signedInApi();
  renderApp('/settings/setup');

  expect(await screen.findByRole('list', { name: setup.listLabel })).toBeInTheDocument();
});

it('connections still says what is coming', async () => {
  signedInApi({ 'GET /api/ads/accounts': () => ({ body: { accounts: [], managerId: null, businessId: null } }) });
  api.routes['GET /api/calendar/connection'] = () => ({ body: { provider: null, status: null, accountEmail: null, calendarId: null, calendarName: null, lastSyncedAt: null, configured: { google: false, microsoft: false } } });
  api.routes['GET /api/company'] = () => ({ body: { id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active', legalName: null, phone: null, email: null, website: null, addressStreet: null, addressCity: null, addressState: null, addressZip: null, timezone: 'America/Chicago', logoUrl: null, located: false, serviceAreaMiles: null } });
  renderApp('/settings/connections');

  expect(await screen.findByText(connections.later)).toBeInTheDocument();
  expect(screen.getAllByText(connections.later)).toHaveLength(1);
  expect(await screen.findByRole('heading', { name: connections.googleAds })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: connections.meta })).toBeInTheDocument();
});

it('sign-up is open without a session', async () => {
  api = stubApi({
    'GET /api/auth/me': () => ({ status: 401, body: { error: 'Sign in first.' } }),
    'GET /api/auth/config': () => ({ body: { googleClientId: null } }),
  });
  renderApp('/sign-up');

  expect(await screen.findByRole('heading', { name: auth.signUpTitle })).toBeInTheDocument();
});
