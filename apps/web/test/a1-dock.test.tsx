import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { dock, WINDOW_COPY } from '../src/copy/dock.ts';
import { DOCK_APPS } from '../src/shell/apps.ts';
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

/** A dock link by its label. Its name also holds the "Coming soon" note and any badge, so only the start of the name is matched. */
function dockLink(dockNav: HTMLElement, label: string) {
  return within(dockNav).getByRole('link', { name: new RegExp('^' + label) });
}


describe('A1 dock', () => {
  it('shows Agents as shipped: no Coming soon note', async () => {
    signedInApi();
    renderApp('/');
    const dockNav = await screen.findByRole('navigation', { name: dock.label });
    const link = dockLink(dockNav, WINDOW_COPY.agents.title);

    expect(link.textContent ?? '').not.toContain(dock.comingSoon);
    expect(link.getAttribute('href')).toBe('/agents');
  });

  it('keeps the Coming soon note on Front Desk', async () => {
    signedInApi();
    renderApp('/');
    const dockNav = await screen.findByRole('navigation', { name: dock.label });

    for (const key of ['front-desk'] as const) {
      expect(dockLink(dockNav, WINDOW_COPY[key].title).textContent ?? '').toContain(dock.comingSoon);
    }
  });

  it('marks Agents shipped (Estimator and Storm too, from E1 and S1)', () => {
    const shipped = Object.fromEntries(DOCK_APPS.map((app) => [app.key, app.shipped]));
    expect(shipped).toEqual({ storm: true, 'front-desk': false, estimator: true, jobs: true, calendar: true, agents: true });
  });
});
