import { cleanup, configure, render, screen, within } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyBody } from '../src/api/types.ts';
import { createAppRouter } from '../src/app/router.tsx';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { today } from '../src/copy/today.ts';
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

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Renders the app at `initialEntries` with the shell's reads stubbed, plus `own` routes. */
function mount(initialEntries: string[], own: Parameters<typeof stubApi>[0] = {}) {
  api = stubApi({
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

const TODAY_BODY = {
  appointments: [
    {
      id: 'ap1',
      kind: 'inspection',
      title: 'Roof inspection',
      startsAt: '2026-10-12T15:00:00.000Z',
      endsAt: '2026-10-12T16:00:00.000Z',
      allDay: false,
      customerName: 'Maria Lopez',
      addressLine: '12 Oak St',
    },
  ],
  followUps: [{ id: 'j9', customerName: 'Ben Carter', addressLine: '3 Elm St', nextStep: 'Send proposal', nextStepOn: '2026-10-12' }],
};

async function todayWindow() {
  return screen.findByRole('dialog');
}

describe('the Today window with CRM data', () => {
  it('lists appointments and follow-ups from /api/today', async () => {
    mount(['/today'], { 'GET /api/today': () => ({ body: TODAY_BODY }) });

    const dialog = await todayWindow();
    const list = await within(dialog).findByRole('list', { name: today.appointmentsLabel });
    expect(within(list).getByText('Maria Lopez')).toBeInTheDocument();
    expect(within(list).getByText('12 Oak St')).toBeInTheDocument();
    expect(within(list).getByText(today.kindLabel.inspection)).toBeInTheDocument();
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/calendar/appointments/ap1');

    const followUps = await within(dialog).findByRole('list', { name: today.followUpsLabel });
    expect(within(followUps).getByText('Ben Carter')).toBeInTheDocument();
    expect(within(followUps).getByText('Send proposal')).toBeInTheDocument();
    expect(within(followUps).getByRole('link')).toHaveAttribute('href', '/jobs/j9');
    expect(api.unexpected).toEqual([]);
  });

  it('shows the see-everyone link for owner and office only', async () => {
    for (const role of ['owner', 'office']) {
      mount(['/today'], {
        'GET /api/today': () => ({ body: TODAY_BODY }),
        'GET /api/auth/me': () => ({ body: { ...DANA, role } }),
      });
      const link = await screen.findByRole('link', { name: today.seeEveryone });
      expect(link.getAttribute('href')).toMatch(/^\/calendar\?view=day&date=/);
      cleanup();
    }

    mount(['/today'], {
      'GET /api/today': () => ({ body: TODAY_BODY }),
      'GET /api/auth/me': () => ({ body: { ...DANA, role: 'rep' } }),
    });
    const dialog = await todayWindow();
    await within(dialog).findByText('Maria Lopez');
    expect(screen.queryByRole('link', { name: today.seeEveryone })).toBeNull();
    cleanup();
  });

  it('hides Follow up today when there are none and shows the empty line', async () => {
    mount(['/today']);

    expect(await screen.findByText(today.noAppointments)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: today.followUps })).toBeNull();
    expect(api.unexpected).toEqual([]);
  });
});
