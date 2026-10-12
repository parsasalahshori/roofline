import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { DEFAULT_TIER_TEMPLATES } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { dock, WINDOW_COPY } from '../src/copy/dock.ts';
import { estimator } from '../src/copy/estimator.ts';
import { homeowner } from '../src/copy/homeowner.ts';
import { measure } from '../src/copy/measure.ts';
import { prices } from '../src/copy/prices.ts';
import { proposals } from '../src/copy/proposals.ts';
import { estimateCopy, financeCopy } from '../src/copy/financeEstimate.ts';
import { tierEditor } from '../src/copy/tiersEditor.ts';
import type { EstimatorSettings } from '../src/features/settings/estimator-api.ts';
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

describe('E1 windows', () => {
  it.each([
    ['/estimator', estimator.comingSoon],
    ['/estimator/measure/m1', measure.comingSoon],
    ['/estimator/proposals/p1', proposals.comingSoon],
  ])('%s shows its placeholder', async (path, copy) => {
    signedInApi();
    renderApp(path);

    expect(await screen.findByText(copy)).toBeInTheDocument();
  });

  it('/p/abc renders without a session and without the shell', async () => {
    api = stubApi({ 'GET /api/auth/me': () => ({ status: 401, body: { error: 'Sign in first.' } }) });
    const { router } = renderApp('/p/abc');

    expect(await screen.findByText(homeowner.comingSoon)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: dock.label })).toBeNull();
    expect(document.querySelector('[data-map-mock]')).toBeNull();
    expect(where(router)).toBe('/p/abc');
  });

  it('the dock Estimator has no Coming soon note', async () => {
    signedInApi();
    renderApp('/estimator');
    const dockNav = await screen.findByRole('navigation', { name: dock.label });

    expect(dockLink(dockNav, WINDOW_COPY.estimator.title).textContent ?? '').not.toContain(dock.comingSoon);
    expect(dockLink(dockNav, WINDOW_COPY.storm.title).textContent ?? '').toContain(dock.comingSoon);
  });

  it('Settings Prices shows the three E1 sections', async () => {
    const settingsBody: EstimatorSettings = {
      defaultPitchX12: 6,
      overhangFt: 1,
      proposalValidDays: 30,
      aerialMeasure: false,
      aerialConfigured: false,
      estimateChangeClause: true,
      financingAprBps: null,
      financingTermMonths: null,
    };
    signedInApi(ACCOUNT, {
      'GET /api/tier-templates': () => ({ body: { templates: DEFAULT_TIER_TEMPLATES.map((t) => ({ ...t, addOns: [...t.addOns], highlights: [...t.highlights] })) } }),
      'GET /api/estimator/settings': () => ({ body: settingsBody }),
    });
    renderApp('/settings/prices');

    expect(await screen.findByRole('heading', { name: tierEditor.title })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: financeCopy.title })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: estimateCopy.title })).toBeInTheDocument();
    expect(await screen.findByText(prices.comingSoon)).toBeInTheDocument();
  });
});
