import { cleanup, configure, render, screen, within } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyBody } from '../src/api/types.ts';
import { createAppRouter } from '../src/app/router.tsx';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

// These tests wait on several renders; on a busy machine the defaults are too tight
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const DANA = { ...ACCOUNT, user: { ...ACCOUNT.user, name: 'Dana Ruiz' } };

const COMPANY_BODY: CompanyBody = {
  id: 'c1',
  name: 'Summit Roofing',
  slug: 'summit-roofing',
  status: 'active',
  legalName: null,
  phone: null,
  email: null,
  website: null,
  addressStreet: null,
  addressCity: null,
  addressState: null,
  addressZip: null,
  timezone: 'America/Chicago',
  logoUrl: null,
  located: false,
  serviceAreaMiles: null,
};


afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Renders the app at `initialEntries` with the shell's reads stubbed, plus `own` routes. */
function mount(initialEntries: string[], own: Parameters<typeof stubApi>[0] = {}) {
  stubApi({
    ...SHELL_ROUTES,
    // The pipeline board (the /jobs window) reads the board and the team; both are empty here
    'GET /api/jobs/board': () => ({ body: { columns: [], lost: { count: 0 } } }),
    'GET /api/team': () => ({ body: { members: [] } }),
    'GET /api/today': () => ({ body: { appointments: [], followUps: [] } }),
    'GET /api/auth/me': () => ({ body: DANA }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    ...own,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries });
  const tree = (
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>
  );
  render(tree);
  return { router };
}

const FOLLOW = { customerName: 'Ben Carter', addressLine: '3 Elm St', nextStep: 'Call back', nextStepOn: '2026-10-12' };

function body(frontDesk: 'urgent' | 'message' | null | undefined) {
  return { appointments: [], followUps: [{ id: 'j9', ...FOLLOW, ...(frontDesk === undefined ? {} : { frontDesk }) }] };
}

describe('the Today window marks Front Desk follow-ups', () => {
  it('shows From Front Desk for a message', async () => {
    mount(['/today'], { 'GET /api/today': () => ({ body: body('message') }) });
    const dialog = await screen.findByRole('main');
    expect(await within(dialog).findByText('From Front Desk')).toBeInTheDocument();
    expect(within(dialog).queryByText('Urgent, from Front Desk')).toBeNull();
  });

  it('shows Urgent, from Front Desk for an urgent message', async () => {
    mount(['/today'], { 'GET /api/today': () => ({ body: body('urgent') }) });
    const dialog = await screen.findByRole('main');
    expect(await within(dialog).findByText('Urgent, from Front Desk')).toBeInTheDocument();
    expect(within(dialog).queryByText('From Front Desk')).toBeNull();
  });

  it('shows neither when the follow-up is not from Front Desk', async () => {
    mount(['/today'], { 'GET /api/today': () => ({ body: body(null) }) });
    const dialog = await screen.findByRole('main');
    await within(dialog).findByText('Ben Carter');
    expect(within(dialog).queryByText('From Front Desk')).toBeNull();
    expect(within(dialog).queryByText('Urgent, from Front Desk')).toBeNull();
  });
});
