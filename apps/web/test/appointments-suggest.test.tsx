// The company zone is America/Chicago; the test process runs in UTC, so every positioned element proves the zone is used.
vi.hoisted(() => {
  process.env.TZ = 'UTC';
});

import type { AppointmentView } from '@roofline/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyBody, TeamBody } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { appointments } from '../src/copy/appointments.ts';
import { AppointmentWindow } from '../src/features/appointments/AppointmentWindow.tsx';
import { ConflictWarnings } from '../src/features/appointments/ConflictWarnings.tsx';
import { SuggestedTimes } from '../src/features/appointments/SuggestedTimes.tsx';
import type { Slot } from '../src/features/appointments/types.ts';
import { ACCOUNT, type Reply, type Routes, stubApi } from './helpers.tsx';

const CHICAGO = 'America/Chicago';
/** The fixed clock of every test in this file. The window is then 2026-10-12 15:00 to 2026-10-26 15:00 UTC. */
const NOW = '2026-10-12T15:00:00.000Z';
const WINDOW_TO = '2026-10-26T15:00:00.000Z';

/** Seven open slots starting Tue 2026-10-13 19:00 UTC (2:00 PM in Chicago). */
const SLOTS: Slot[] = [
  { start: '2026-10-13T19:00:00.000Z', end: '2026-10-13T19:30:00.000Z', userIds: ['u1'] },
  { start: '2026-10-13T19:30:00.000Z', end: '2026-10-13T20:00:00.000Z', userIds: ['u1', 'u2'] },
  { start: '2026-10-13T20:00:00.000Z', end: '2026-10-13T20:30:00.000Z', userIds: ['u2'] },
  { start: '2026-10-13T21:00:00.000Z', end: '2026-10-13T21:30:00.000Z', userIds: ['u1'] },
  { start: '2026-10-13T22:00:00.000Z', end: '2026-10-13T22:30:00.000Z', userIds: ['u2'] },
  { start: '2026-10-13T23:00:00.000Z', end: '2026-10-13T23:30:00.000Z', userIds: ['u1'] },
  { start: '2026-10-14T00:00:00.000Z', end: '2026-10-14T00:30:00.000Z', userIds: ['u2'] },
];

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
  timezone: CHICAGO,
  logoUrl: null,
  located: false,
  serviceAreaMiles: null,
};

const TEAM_BODY: TeamBody = {
  members: [
    { id: 'm1', userId: 'u1', name: 'Sam', email: 'sam@example.com', role: 'owner', canApproveSpend: true, status: 'active', stormAlertEmail: true },
    { id: 'm2', userId: 'u2', name: 'Jo', email: 'jo@example.com', role: 'rep', canApproveSpend: false, status: 'active', stormAlertEmail: true },
  ],
  invites: [],
};

function makeAppointment(overrides: Partial<AppointmentView> & { id: string }): AppointmentView {
  return {
    kind: 'inspection',
    title: 'Inspection',
    status: 'scheduled',
    startsAt: '2026-10-13T19:00:00.000Z',
    endsAt: '2026-10-13T19:30:00.000Z',
    allDay: false,
    assigned: { userId: 'u1', name: 'Sam' },
    jobId: null,
    customerId: null,
    customerName: 'Maple Ridge',
    propertyId: null,
    addressLine: null,
    notes: null,
    source: 'manual',
    sync: 'none',
    confirmedAt: null,
    confirmedVia: null,
    canEdit: true,
    ...overrides,
  };
}

let api: ReturnType<typeof stubApi>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/**
 * Stubs the reads the sheet makes. Every GET /api/calendar/availability?… answers `availability`;
 * the tests read the query string from `api.calls`. Extra routes are added on top.
 */
function stubSheet(availability: { slots: Slot[] } | Reply = { body: { slots: SLOTS } }, extra: Routes = {}) {
  const routes: Routes = {
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    'GET /api/team': () => ({ body: TEAM_BODY }),
    ...extra,
  };
  const reply: Reply = 'body' in availability ? availability : { body: availability };
  const withAvailability = new Proxy(routes, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key.startsWith('GET /api/calendar/availability?')) return () => reply;
      return Reflect.get(target, key, receiver);
    },
  });
  api = stubApi(withAvailability);
  return api;
}

/** Renders `ui` as the route `routePath` (so useParams works), starting at `path`, under the app's providers. */
function renderRoute(ui: ReactElement, routePath: string, path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter([{ path: routePath, element: ui }], { initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

/** The suggestions list, found by its label. */
async function suggestionList(): Promise<HTMLElement> {
  return screen.findByRole('list', { name: appointments.suggestedTitle });
}

describe('SuggestedTimes', () => {
  it('SuggestedTimes shows the next 5 slots as buttons in the company zone', async () => {
    stubSheet();
    renderRoute(<SuggestedTimes kind="inspection" userId="" propertyId="" zone={CHICAGO} onPick={vi.fn()} />, '*', '/');

    const buttons = await within(await suggestionList()).findAllByRole('button');
    expect(buttons).toHaveLength(5);
    expect(buttons[0]).toHaveTextContent('Tue 2:00 PM · Sam');

    const query = new URL(api.calls.find((call) => call.url.startsWith('/api/calendar/availability?'))!.url, 'http://localhost').searchParams;
    expect(query.get('kind')).toBe('inspection');
    expect(query.get('from')).toBe(NOW);
    expect(query.get('to')).toBe(WINDOW_TO);
    expect(query.has('userId')).toBe(false);
  });

  it('clicking a slot calls onPick with the slot and its first member', async () => {
    stubSheet();
    const onPick = vi.fn();
    const { user } = renderRoute(<SuggestedTimes kind="inspection" userId="" propertyId="" zone={CHICAGO} onPick={onPick} />, '*', '/');

    const buttons = await within(await suggestionList()).findAllByRole('button');
    await user.click(buttons[0]!);

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(SLOTS[0], 'u1');
  });

  it('shows the empty line when there are no slots', async () => {
    stubSheet({ slots: [] });
    renderRoute(<SuggestedTimes kind="adjuster" userId="" propertyId="" zone={CHICAGO} onPick={vi.fn()} />, '*', '/');

    expect(await screen.findByText(appointments.suggestedEmpty)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: appointments.suggestedTitle })).toBeNull();
  });

  it('ConflictWarnings lists each warning and fires Keep it and Change time', async () => {
    const onKeep = vi.fn();
    const onChange = vi.fn();
    const { user } = renderRoute(
      <ConflictWarnings warnings={['Sam already has an inspection at 2:00 PM.', 'Outside the work hours.']} onKeep={onKeep} onChange={onChange} />,
      '*',
      '/',
    );

    expect(screen.getByText('Sam already has an inspection at 2:00 PM.')).toBeInTheDocument();
    expect(screen.getByText('Outside the work hours.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: appointments.keepIt }));
    await user.click(screen.getByRole('button', { name: appointments.changeTime }));

    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('AppointmentWindow on /calendar/new renders the form', async () => {
    stubSheet();
    renderRoute(<AppointmentWindow />, '/calendar/new', '/calendar/new');

    expect(await screen.findByText(appointments.kindLabel)).toBeInTheDocument();
  });

  it('AppointmentWindow on an existing appointment shows the detail and Reschedule swaps in the form', async () => {
    stubSheet(
      { slots: SLOTS },
      {
        'GET /api/appointments/a1': () => ({ body: makeAppointment({ id: 'a1' }) }),
        'GET /api/calendar/connection': () => ({ body: { provider: null } }),
      },
    );
    const { user } = renderRoute(<AppointmentWindow />, '/calendar/appointments/:appointmentId', '/calendar/appointments/a1');

    expect(await screen.findByText(appointments.detailTime)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: appointments.reschedule }));

    expect(await screen.findByText(appointments.kindLabel)).toBeInTheDocument();
    expect(screen.queryByText(appointments.detailTime)).toBeNull();
  });
});
