import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { rail, WINDOW_COPY } from '../src/copy/rail.ts';
import { currentApp, RAIL_LAYOUT } from '../src/shell/apps.ts';
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

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A signed-in person whose shell reads answer "nothing", unless a test gives its own answers. */
function signedInApi(account = ACCOUNT, overrides: Routes = {}) {
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: account }), ...overrides });
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

/** A rail link by its label. Its name also holds any count, so only the start of the name is matched. */
function railLink(nav: HTMLElement, label: string) {
  return within(nav).getByRole('link', { name: new RegExp('^' + label) });
}

describe('A1 rail', () => {
  it('links Agents to /agents', async () => {
    signedInApi();
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: rail.label });
    expect(railLink(nav, WINDOW_COPY.agents.title).getAttribute('href')).toBe('/agents');
  });

  it('links every app to its own page', async () => {
    signedInApi();
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: rail.label });
    const hrefs = Object.fromEntries(RAIL_LAYOUT.flatMap((group) => group.apps).map((app) => [app.key, railLink(nav, WINDOW_COPY[app.key].title).getAttribute('href')]));
    expect(hrefs).toEqual({
      home: '/',
      today: '/today',
      jobs: '/jobs',
      calendar: '/calendar',
      customers: '/customers',
      estimator: '/estimator',
      approvals: '/approvals',
      'front-desk': '/front-desk',
      agents: '/agents',
      storm: '/storm',
      orders: '/estimator/windows',
      scans: '/scans',
      settings: '/settings',
    });
  });

  it('groups the apps: core, AI team, field, then Settings at the foot', async () => {
    signedInApi();
    renderApp('/');
    await screen.findByRole('navigation', { name: rail.label });
    const ai = screen.getByRole('group', { name: rail.groupAi });
    expect(within(ai).getAllByRole('link').map((link) => link.getAttribute('data-app'))).toEqual(['approvals', 'front-desk', 'agents']);
    const field = screen.getByRole('group', { name: rail.groupField });
    expect(within(field).getAllByRole('link').map((link) => link.getAttribute('data-app'))).toEqual(['storm', 'orders', 'scans']);
  });

  it('marks the current app, and Factory orders only on an order sheet', () => {
    expect(currentApp('/')).toBe('home');
    expect(currentApp('/jobs/j1')).toBe('jobs');
    expect(currentApp('/estimator/windows/w1')).toBe('estimator');
    expect(currentApp('/estimator/windows/w1/order')).toBe('orders');
    expect(currentApp('/storm/routes')).toBe('storm');
    expect(currentApp('/scans')).toBe('scans');
    expect(currentApp('/scans/s1')).toBe('scans');
    expect(currentApp('/nowhere')).toBeNull();
  });
});
