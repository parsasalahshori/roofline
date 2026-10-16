import { cleanup, configure, render, screen, within } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyBody } from '../src/api/types.ts';
import { createAppRouter } from '../src/app/router.tsx';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { today } from '../src/copy/today.ts';
import { ACCOUNT, SHELL_ROUTES, signedTodayRoute, stubApi } from './helpers.tsx';

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
    ...signedTodayRoute(),
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
  return screen.findByRole('main');
}

describe('the Today window with CRM data', () => {
  it('lists appointments and follow-ups from /api/today', async () => {
    mount(['/today'], { 'GET /api/today': () => ({ body: TODAY_BODY }) });

    const dialog = await todayWindow();
    const list = await within(dialog).findByRole('list', { name: today.appointmentsLabel });
    expect(within(list).getByText('Maria Lopez')).toBeInTheDocument();
    expect(within(list).getByText('12 Oak St')).toBeInTheDocument();
    expect(within(list).getByText(today.kindLabel.inspection)).toBeInTheDocument();
    const [visitLink] = within(list).getAllByRole('link');
    expect(visitLink).toHaveAttribute('href', '/calendar/appointments/ap1');
    // Directions to the address, as a link to a maps page in a new tab
    const directions = within(list).getByRole('link', { name: today.directionsTo('Maria Lopez') });
    expect(directions).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=12%20Oak%20St');
    expect(directions).toHaveAttribute('target', '_blank');

    const followUps = await within(dialog).findByRole('list', { name: today.followUpsLabel });
    expect(within(followUps).getByText('Ben Carter')).toBeInTheDocument();
    expect(within(followUps).getByText('Send proposal')).toBeInTheDocument();
    expect(within(followUps).getByRole('link')).toHaveAttribute('href', '/jobs/j9');
    expect(api.unexpected).toEqual([]);
  });

  it('marks the visit that is next and the one that is done, each with a word as well as a colour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T14:30:00.000Z')); // 9:30 in Chicago
    const visit = (id: string, startsAt: string, endsAt: string, status: string, who: string) => ({
      id,
      kind: 'inspection',
      title: 'Roof inspection',
      status,
      startsAt,
      endsAt,
      allDay: false,
      customerName: who,
      addressLine: `${id} Oak St`,
    });
    mount(['/today'], {
      'GET /api/today': () => ({
        body: {
          appointments: [
            visit('v2', '2026-10-12T16:00:00.000Z', '2026-10-12T17:00:00.000Z', 'scheduled', 'Second Visit'),
            visit('v1', '2026-10-12T13:00:00.000Z', '2026-10-12T14:00:00.000Z', 'completed', 'First Visit'),
            visit('v3', '2026-10-12T18:00:00.000Z', '2026-10-12T19:00:00.000Z', 'scheduled', 'Third Visit'),
          ],
          followUps: [],
        },
      }),
    });

    const list = await screen.findByRole('list', { name: today.appointmentsLabel });
    await within(list).findByText('Second Visit');
    const rows = within(list).getAllByRole('listitem');
    // Earliest first
    expect(rows.map((row) => within(row).getByText(/Visit$/).textContent)).toEqual(['First Visit', 'Second Visit', 'Third Visit']);
    expect(within(rows[0]!).getByText(today.done)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(today.next)).toBeInTheDocument();
    expect(within(rows[2]!).queryByText(today.next)).toBeNull();
    expect(rows[1]).toHaveAttribute('data-next', 'true');
    expect(within(screen.getByRole('region', { name: new RegExp(today.appointments) })).getByText(today.visitsCount(3))).toBeInTheDocument();
  });

  it('flags the follow-ups the Front Desk raised, in words', async () => {
    mount(['/today'], {
      'GET /api/today': () => ({
        body: {
          appointments: [],
          followUps: [
            { id: 'j1', customerName: 'Ann Urgent', nextStep: 'Call back', frontDesk: 'urgent' },
            { id: 'j2', customerName: 'Bo Message', nextStep: null, frontDesk: 'message' },
            { id: 'j3', customerName: 'Cy Plain', nextStep: 'Send proposal', frontDesk: null },
          ],
        },
      }),
    });

    const followUps = await screen.findByRole('list', { name: today.followUpsLabel });
    const rows = within(followUps).getAllByRole('listitem');
    expect(within(rows[0]!).getByText(today.fromFrontDeskUrgent)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(today.fromFrontDesk)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(today.nextStep(null))).toBeInTheDocument();
    expect(within(rows[2]!).queryByText(/Front Desk/)).toBeNull();
  });

  it('shows this month: what was signed and the open pipeline', async () => {
    mount(['/today'], {
      'GET /api/home/signed': () => ({ body: { monthTotalCents: 1555300, goalCents: null, weekly: [], openPipelineCents: 3292200 } }),
    });

    const month = await screen.findByRole('region', { name: today.thisMonth });
    expect(await within(month).findByText('$15,553')).toBeInTheDocument();
    expect(within(month).getByText('$32,922')).toBeInTheDocument();
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
