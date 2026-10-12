import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { agents } from '../src/copy/agents.ts';
import { settings } from '../src/copy/settings.ts';
import { isSettingsTab, SETTINGS_TABS, visibleTabs } from '../src/features/settings/tabs.ts';
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
  return { router, queryClient };
}

const settingsTabs = () => screen.findByRole('navigation', { name: settings.tabsLabel });

describe('settings agents tab', () => {
  it('shows Agents to the owner', async () => {
    signedInApi();
    renderApp('/settings/agents');

    expect(await screen.findByText(agents.settingsComingSoon)).toBeInTheDocument();
    expect(within(await settingsTabs()).getByRole('link', { name: settings.tabs.agents })).toHaveAttribute('href', '/settings/agents');
  });

  it('shows Agents to the office', async () => {
    signedInApi({ ...ACCOUNT, role: 'office' });
    renderApp('/settings/agents');

    expect(await screen.findByText(agents.settingsComingSoon)).toBeInTheDocument();
    expect(within(await settingsTabs()).getByRole('link', { name: settings.tabs.agents })).toHaveAttribute('href', '/settings/agents');
  });

  it('hides Agents from a rep and sends the rep to Company', async () => {
    signedInApi({ ...ACCOUNT, role: 'rep' }, { 'GET /api/company': () => ({ body: COMPANY }) });
    const { router } = renderApp('/settings/agents');

    await waitFor(() => expect(where(router)).toBe('/settings/company'));
    expect(within(await settingsTabs()).queryByRole('link', { name: settings.tabs.agents })).not.toBeInTheDocument();
    expect(screen.queryByText(agents.settingsComingSoon)).not.toBeInTheDocument();
  });
});

describe('visibleTabs with the agents tab', () => {
  it('gives the owner and the office Agents and Prices', () => {
    for (const role of ['owner', 'office'] as const) {
      expect(visibleTabs(role)).toContain('agents');
      expect(visibleTabs(role)).toContain('prices');
    }
  });

  it('hides Agents and Prices from a rep and from an unknown role', () => {
    for (const role of ['rep', undefined] as const) {
      expect(visibleTabs(role)).not.toContain('agents');
      expect(visibleTabs(role)).not.toContain('prices');
    }
  });

  it('lists eleven tabs, Agents among them', () => {
    expect(SETTINGS_TABS).toHaveLength(11);
    expect(isSettingsTab('agents')).toBe(true);
  });
});
