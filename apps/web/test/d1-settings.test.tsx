import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { frontDeskSettings } from '../src/copy/front-desk-settings.ts';
import { settings } from '../src/copy/settings.ts';
import { visibleTabs } from '../src/features/settings/tabs.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

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

const SETUP_VIEW = {
  items: [{ key: 'company_basics', status: 'todo', comingWith: null, skippable: false, data: {} }],
  progress: { done: 0, total: 5 },
} as const;

const TEXTING_VIEW = { state: 'approved', reason: null, rejectedFields: [], brand: null, defaults: {}, submittedAt: null, approvedAt: '2026-10-01T10:00:00.000Z', number: '+14025550100', needsPaymentMethod: false, needsVerifiedEmail: false, hostedPolicyUrls: { privacy: 'https://example.test/privacy', terms: 'https://example.test/terms' } };

type RoleName = 'owner' | 'office' | 'rep';

const FRONT_DESK_SETTINGS = {
  enabled: false,
  blockedReason: 'no_number',
  texts: true,
  voice: 'maya',
  facts: '',
  canMove: false,
  canCancel: false,
  ringTeamFirstSeconds: 0,
  missedCallTextBack: false,
  recordingRetentionDays: 30,
  transcriptRetentionDays: 90,
  maxConcurrentAiCalls: 3,
  forwardingVerifiedAt: null,
  onCall: [],
};

function signedInAs(role: RoleName) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    'GET /api/team': () => ({ body: { members: [], invites: [] } }),
    'GET /api/setup': () => ({ body: SETUP_VIEW }),
    'GET /api/front-desk/settings': () => ({ body: FRONT_DESK_SETTINGS }),
    'GET /api/front-desk/voices': () => ({ body: [{ id: 'maya', label: 'Maya', previewUrl: null }] }),
    'GET /api/texting': () => ({ body: TEXTING_VIEW }),
    'GET /api/me/transfer-phone': () => ({ body: { e164: null, prefill: null, recordingAcknowledgedAt: null } }),
  });
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
  return { router };
}

const tabsNav = () => screen.findByRole('navigation', { name: settings.tabsLabel });

describe('Front Desk tab', () => {
  it.each(['owner', 'office'] as const)('is shown to %s', async (role) => {
    signedInAs(role);
    renderApp('/settings/front-desk');

    expect(await screen.findByText(frontDeskSettings.onOff.label)).toBeInTheDocument();
    const nav = await tabsNav();
    expect(within(nav).getByRole('link', { name: settings.tabs['front-desk'] })).toHaveAttribute('aria-current', 'page');
  });

  it('is hidden from a field rep', async () => {
    signedInAs('rep');
    renderApp('/settings/company');

    const nav = await tabsNav();
    await waitFor(() => expect(within(nav).queryByRole('link', { name: settings.tabs.prices })).not.toBeInTheDocument());
    expect(within(nav).queryByRole('link', { name: settings.tabs['front-desk'] })).not.toBeInTheDocument();
  });

  it('sends a field rep who opens it to Company', async () => {
    signedInAs('rep');
    const { router } = renderApp('/settings/front-desk');

    await waitFor(() => expect(where(router)).toBe('/settings/company'));
    expect(screen.queryByText(frontDeskSettings.onOff.label)).not.toBeInTheDocument();
  });
});

describe('Your profile tab', () => {
  it.each(['owner', 'office', 'rep'] as const)('is shown to %s with the transfer phone', async (role) => {
    signedInAs(role);
    renderApp('/settings/profile');

    expect(await screen.findByText(frontDeskSettings.transferPhone.heading)).toBeInTheDocument();
    const nav = await tabsNav();
    expect(within(nav).getByRole('link', { name: settings.tabs.profile })).toHaveAttribute('aria-current', 'page');
  });
});

describe('visibleTabs', () => {
  const ALL = ['company', 'team', 'prices', 'schedule', 'connections', 'billing', 'setup', 'front-desk', 'profile'];
  const LIMITED = ['company', 'team', 'schedule', 'connections', 'billing', 'setup', 'profile'];

  it('gives owner and office all nine tabs', () => {
    expect(visibleTabs('owner')).toEqual(ALL);
    expect(visibleTabs('office')).toEqual(ALL);
  });

  it('hides Prices and Front Desk from a rep and while the role is unknown', () => {
    expect(visibleTabs('rep')).toEqual(LIMITED);
    expect(visibleTabs(undefined)).toEqual(LIMITED);
  });
});
