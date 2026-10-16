import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarConnectionView } from '@roofline/shared';
import type { CompanyBody } from '../src/api/types.ts';
import { connections } from '../src/copy/connections.ts';
import { CalendarConnection } from '../src/features/settings/CalendarConnection.tsx';
import { ACCOUNT, renderAt, SHELL_ROUTES, stubApi } from './helpers.tsx';

const COMPANY: CompanyBody = {
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
  located: false,
  serviceAreaMiles: null,
};

const NOT_CONNECTED: CalendarConnectionView = {
  provider: null,
  status: null,
  accountEmail: null,
  calendarId: null,
  calendarName: null,
  lastSyncedAt: null,
  configured: { google: true, microsoft: true },
};

const CONNECTED: CalendarConnectionView = {
  provider: 'google',
  status: 'connected',
  accountEmail: 'sam@example.com',
  calendarId: 'primary',
  calendarName: 'Main',
  lastSyncedAt: '2026-10-12T15:30:00.000Z',
  configured: { google: true, microsoft: true },
};

const CALENDARS = [
  { id: 'primary', name: 'Main' },
  { id: 'work', name: 'Work' },
];

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** The signed-in owner, the company, and the connection as the server answers it. */
function stubConnection(view: CalendarConnectionView, extra: Parameters<typeof stubApi>[0] = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: COMPANY }),
    'GET /api/calendar/connection': () => ({ body: view }),
    ...extra,
  });
  return api;
}

describe('your calendar', () => {
  it('not configured disables both connect buttons and says so', async () => {
    stubConnection({ ...NOT_CONNECTED, configured: { google: false, microsoft: false } });
    renderAt(<CalendarConnection />, '/settings/connections');

    expect(await screen.findByText(connections.notConfigured)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: connections.connect.google })).toBeDisabled();
    expect(screen.getByRole('button', { name: connections.connect.microsoft })).toBeDisabled();
    expect(document.querySelector('a[href="/api/calendar/connect/google"]')).toBeNull();
    expect(document.querySelector('a[href="/api/calendar/connect/microsoft"]')).toBeNull();
  });

  it('not connected offers two connect links', async () => {
    stubConnection(NOT_CONNECTED);
    renderAt(<CalendarConnection />, '/settings/connections');

    const google = await screen.findByRole('link', { name: 'Connect Google Calendar' });
    expect(google).toHaveAttribute('href', '/api/calendar/connect/google');
    const outlook = screen.getByRole('link', { name: 'Connect Outlook' });
    expect(outlook).toHaveAttribute('href', '/api/calendar/connect/microsoft');
    expect(screen.queryByText(connections.notConfigured)).toBeNull();
  });

  it('connected shows the account and changes the calendar', async () => {
    stubConnection(CONNECTED, {
      'GET /api/calendar/connection/calendars': () => ({ body: CALENDARS }),
      'PATCH /api/calendar/connection': () => ({ body: { ...CONNECTED, calendarId: 'work', calendarName: 'Work' } }),
    });
    const { user } = renderAt(<CalendarConnection />, '/settings/connections');

    expect(await screen.findByText('sam@example.com')).toBeInTheDocument();
    // The calendar is a list that opens: it shows the one in use, and lists the others once they are read
    const calendar = await screen.findByLabelText(connections.calendarLabel);
    expect(calendar).toHaveTextContent('Main');
    await waitFor(() => expect(api.count('GET /api/calendar/connection/calendars')).toBe(1));
    await user.click(calendar);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    await user.click(screen.getByRole('option', { name: 'Work' }));

    await waitFor(() => expect(api.sent('PATCH /api/calendar/connection')).toEqual([{ calendarId: 'work' }]));
  });

  it('disconnect asks first', async () => {
    stubConnection(CONNECTED, {
      'GET /api/calendar/connection/calendars': () => ({ body: CALENDARS }),
      'DELETE /api/calendar/connection': () => ({ status: 200, body: {} }),
    });
    const { user } = renderAt(<CalendarConnection />, '/settings/connections');

    await user.click(await screen.findByRole('button', { name: connections.disconnect }));
    expect(screen.getByText(connections.disconnectConfirm)).toBeInTheDocument();
    expect(api.count('DELETE /api/calendar/connection')).toBe(0);

    await user.click(screen.getByRole('button', { name: connections.confirmYes }));
    await waitFor(() => expect(api.count('DELETE /api/calendar/connection')).toBe(1));
  });

  it('an error connection shows the reconnect banner', async () => {
    stubConnection({ ...CONNECTED, status: 'error' });
    renderAt(<CalendarConnection />, '/settings/connections');

    expect(await screen.findByText(connections.reconnectTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: connections.connect.google })).toHaveAttribute(
      'href',
      '/api/calendar/connect/google',
    );
  });

  it('the calendar query toasts once', async () => {
    stubConnection(NOT_CONNECTED);
    const { queryClient } = renderAt(<CalendarConnection />, '/settings/connections?calendar=connected');

    expect(await screen.findByText(connections.toasts.connected)).toBeInTheDocument();
    await queryClient.refetchQueries();
    expect(screen.getAllByText(connections.toasts.connected)).toHaveLength(1);
  });

  it('the tag beside the title says how the connection stands, in an icon and a word', async () => {
    stubConnection(NOT_CONNECTED);
    renderAt(<CalendarConnection />, '/settings/connections');
    const off = await screen.findByRole('region', { name: connections.calendarTitle });
    expect(await within(off).findByText(connections.notConnected)).toBeInTheDocument();
    cleanup();

    stubConnection({ ...CONNECTED, status: 'error' });
    renderAt(<CalendarConnection />, '/settings/connections');
    const broken = await screen.findByRole('region', { name: connections.calendarTitle });
    expect(await within(broken).findByText(connections.statuses.error)).toBeInTheDocument();
    cleanup();

    stubConnection(CONNECTED, { 'GET /api/calendar/connection/calendars': () => ({ body: CALENDARS }) });
    renderAt(<CalendarConnection />, '/settings/connections');
    const on = await screen.findByRole('region', { name: connections.calendarTitle });
    expect(await within(on).findByText(connections.statuses.active)).toBeInTheDocument();
  });

  it('connected shows when it last synced, in the company zone, and says so when it never did', async () => {
    stubConnection(CONNECTED, { 'GET /api/calendar/connection/calendars': () => ({ body: CALENDARS }) });
    renderAt(<CalendarConnection />, '/settings/connections');

    // 15:30 UTC is 10:30 in Chicago in October
    expect(await screen.findByText('Oct 12, 2026, 10:30 AM')).toBeInTheDocument();
    expect(screen.getByText(connections.lastSyncedLabel)).toBeInTheDocument();
    cleanup();

    stubConnection({ ...CONNECTED, lastSyncedAt: null }, { 'GET /api/calendar/connection/calendars': () => ({ body: CALENDARS }) });
    renderAt(<CalendarConnection />, '/settings/connections');
    expect(await screen.findByText(connections.neverSynced)).toBeInTheDocument();
  });
});
