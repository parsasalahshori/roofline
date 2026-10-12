import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { create } from '../src/copy/create.ts';
import { customers } from '../src/copy/customers.ts';
import { dock, WINDOW_COPY } from '../src/copy/dock.ts';
import { job } from '../src/copy/job.ts';
import { jobs } from '../src/copy/jobs.ts';
import { prices } from '../src/copy/prices.ts';
import { quotes } from '../src/copy/quotes.ts';
import { schedule } from '../src/copy/schedule.ts';
import { settings } from '../src/copy/settings.ts';
import { ACCOUNT, COMPANY, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

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
function signedInApi(account = ACCOUNT, overrides: Routes = {}) {
  // The pipeline board (the /jobs window) reads the board and the team; both are empty here
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    'GET /api/jobs/board': () => ({ body: { columns: [], lost: { count: 0 } } }),
    'GET /api/team': () => ({ body: { members: [] } }),
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

/** A dock link by its label. Its name also holds the "Coming soon" note and any badge, so only the start of the name is matched. */
function dockLink(dockNav: HTMLElement, label: string) {
  return within(dockNav).getByRole('link', { name: new RegExp('^' + label) });
}

/** The row of tab links in the Settings window. */
const settingsTabs = () => screen.findByRole('navigation', { name: settings.tabsLabel });

describe('C1 windows', () => {
  it.each([
    ['/jobs', WINDOW_COPY.jobs.title, jobs.newJob],
    ['/jobs/j1', WINDOW_COPY.jobs.title, job.comingSoon],
    ['/jobs/j1/quotes/q1', WINDOW_COPY.jobs.title, quotes.comingSoon],
    ['/customers', WINDOW_COPY.customers.title, customers.comingSoon],
    ['/customers/c1', WINDOW_COPY.customers.title, customers.customerComingSoon],
  ])('%s shows its placeholder in the %s window', async (path, title, copy) => {
    signedInApi();
    renderApp(path);

    const dialog = await screen.findByRole('dialog', { name: title });
    expect(await within(dialog).findByText(copy)).toBeInTheDocument();
  });

  it('shows the Jobs tabs on the pipeline, with Pipeline marked as the current page', async () => {
    signedInApi();
    renderApp('/jobs');

    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.jobs.title });
    const tabs = within(dialog).getByRole('navigation', { name: jobs.tabsLabel });
    expect(within(tabs).getByRole('link', { name: jobs.tabs.pipeline })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: jobs.tabs.customers })).toHaveAttribute('href', '/customers');
  });

  it('shows the Customers tab as the current page on the customers list', async () => {
    signedInApi();
    renderApp('/customers');

    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.customers.title });
    const tabs = within(dialog).getByRole('navigation', { name: jobs.tabsLabel });
    expect(within(tabs).getByRole('link', { name: jobs.tabs.customers })).toHaveAttribute('aria-current', 'page');
  });

  it('shows the Not found window for a path nobody has', async () => {
    signedInApi();
    renderApp('/jobs/x/y/z');

    expect(await screen.findByRole('dialog', { name: WINDOW_COPY.notFound.title })).toBeInTheDocument();
  });
});

describe('the New job and New customer screens', () => {
  it('/jobs/new shows the New job steps in the Jobs window', async () => {
    signedInApi();
    renderApp('/jobs/new');

    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.jobs.title });
    expect((await within(dialog).findAllByText(create.newJob.stepCustomer)).length).toBeGreaterThan(0);
  });

  it('/customers/new shows the New customer form in the Customers window', async () => {
    signedInApi();
    renderApp('/customers/new');

    expect(await screen.findByLabelText(create.newCustomer.firstName)).toBeInTheDocument();
  });
});

describe('settings tabs for the C1 screens', () => {
  it('shows Prices to the owner', async () => {
    signedInApi();
    renderApp('/settings/prices');

    expect(await screen.findByText(prices.comingSoon)).toBeInTheDocument();
    expect(within(await settingsTabs()).getByRole('link', { name: settings.tabs.prices })).toBeInTheDocument();
  });

  it('shows Prices to the office', async () => {
    signedInApi({ ...ACCOUNT, role: 'office' });
    renderApp('/settings/prices');

    expect(await screen.findByText(prices.comingSoon)).toBeInTheDocument();
    expect(within(await settingsTabs()).getByRole('link', { name: settings.tabs.prices })).toBeInTheDocument();
  });

  it('sends a rep from Prices to Company', async () => {
    signedInApi({ ...ACCOUNT, role: 'rep' }, { 'GET /api/company': () => ({ body: COMPANY }) });
    const { router } = renderApp('/settings/prices');

    await waitFor(() => expect(where(router)).toBe('/settings/company'));
    const tabs = await settingsTabs();
    expect(within(tabs).getByRole('link', { name: settings.tabs.company })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).queryByRole('link', { name: settings.tabs.prices })).not.toBeInTheDocument();
    expect(screen.queryByText(prices.comingSoon)).not.toBeInTheDocument();
  });

  it('shows Schedule to a rep', async () => {
    signedInApi({ ...ACCOUNT, role: 'rep' });
    renderApp('/settings/schedule');

    expect(await screen.findByText(schedule.comingSoon)).toBeInTheDocument();
  });
});

describe('dock notes', () => {
  it('has no "Coming soon" note on Jobs or Calendar, but keeps it on Storm', async () => {
    signedInApi();
    renderApp('/');
    const dockNav = await screen.findByRole('navigation', { name: dock.label });

    expect(dockLink(dockNav, WINDOW_COPY.jobs.title).textContent ?? '').not.toContain(dock.comingSoon);
    expect(dockLink(dockNav, WINDOW_COPY.calendar.title).textContent ?? '').not.toContain(dock.comingSoon);
    expect(dockLink(dockNav, WINDOW_COPY.storm.title).textContent ?? '').toContain(dock.comingSoon);
  });
});
