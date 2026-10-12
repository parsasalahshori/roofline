// The company zone is America/Chicago; the test process runs in UTC, so a 2:00 PM shown proves the zone is used.
vi.hoisted(() => {
  process.env.TZ = 'UTC';
});

import type { AppointmentView, CalendarConnectionView } from '@roofline/shared';
import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { appointments } from '../src/copy/appointments.ts';
import { AppointmentDetail } from '../src/features/appointments/AppointmentDetail.tsx';
import { useAvailability } from '../src/features/appointments/api.ts';
import { renderAt, type Routes, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A scheduled inspection at 2:00 PM Chicago time (19:00 UTC on 2026-10-13), assigned to Jo Crew. */
const APPOINTMENT: AppointmentView = {
  id: 'a1',
  kind: 'inspection',
  title: 'Roof check',
  status: 'scheduled',
  startsAt: '2026-10-13T19:00:00Z',
  endsAt: '2026-10-13T20:00:00Z',
  allDay: false,
  assigned: { userId: 'u2', name: 'Jo Crew' },
  jobId: 'j1',
  customerId: 'c1',
  customerName: 'Dana Maple',
  propertyId: 'p1',
  addressLine: '412 Maple Ridge Dr, Oak Park, IL',
  notes: 'Gate code at the side.',
  source: 'manual',
  sync: 'synced',
  confirmedAt: null,
  confirmedVia: null,
  canEdit: true,
};

const company = { timezone: 'America/Chicago' };

function connection(provider: 'google' | 'microsoft' | null): CalendarConnectionView {
  return {
    provider,
    status: provider === null ? null : 'active',
    accountEmail: null,
    calendarId: null,
    calendarName: null,
    lastSyncedAt: null,
    configured: { google: true, microsoft: true },
  } as CalendarConnectionView;
}

/** The routes every detail screen reads, plus what the test adds. */
function routesFor(extra: Routes, provider: 'google' | 'microsoft' | null = 'google'): Routes {
  return {
    'GET /api/company': () => ({ body: company }),
    'GET /api/calendar/connection': () => ({ body: connection(provider) }),
    'POST /api/appointments/a1/complete': () => ({ body: { ...APPOINTMENT, status: 'completed' } }),
    'POST /api/appointments/a1/no-show': () => ({ body: { ...APPOINTMENT, status: 'no_show' } }),
    'POST /api/appointments/a1/cancel': () => ({ body: { ...APPOINTMENT, status: 'canceled' } }),
    'PATCH /api/appointments/a1': () => ({ body: { appointment: APPOINTMENT, warnings: [] } }),
    ...extra,
  };
}

function renderDetail(appointment: AppointmentView = APPOINTMENT, onReschedule = vi.fn()) {
  const view = renderAt(<AppointmentDetail appointment={appointment} onReschedule={onReschedule} />, '/calendar/appointments/a1');
  return { ...view, onReschedule };
}

describe('AppointmentDetail', () => {
  it('detail shows time in the company zone, kind, person, links, address and notes', async () => {
    api = stubApi(routesFor({}));
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'Roof check' })).toBeTruthy();
    expect(screen.getByText(/2:00 PM/)).toBeTruthy();
    expect(screen.getByText(appointments.kind.inspection)).toBeTruthy();
    expect(screen.getByText('Jo Crew')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Dana Maple' }).getAttribute('href')).toBe('/customers/c1');
    expect(screen.getByRole('link', { name: appointments.detailJob }).getAttribute('href')).toBe('/jobs/j1');
    const address = screen.getByRole('link', { name: '412 Maple Ridge Dr, Oak Park, IL' });
    expect(address.getAttribute('href')).toContain('?q=412%20Maple%20Ridge%20Dr');
    expect(screen.getByText('Gate code at the side.')).toBeTruthy();
  });

  it('synced shows On your Google calendar for a google connection and On your Outlook calendar for microsoft', async () => {
    api = stubApi(routesFor({}, 'google'));
    renderDetail();
    expect(await screen.findByText('On your Google calendar')).toBeTruthy();
    cleanup();

    api = stubApi(routesFor({}, 'microsoft'));
    renderDetail();
    expect(await screen.findByText('On your Outlook calendar')).toBeTruthy();
  });

  it("failed sync shows Couldn't update your calendar and Try again re-saves the same times", async () => {
    const failed = { ...APPOINTMENT, sync: 'failed' as const };
    api = stubApi(routesFor({}));
    const { user } = renderDetail(failed);

    expect(await screen.findByText(appointments.sync.failed)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: appointments.sync.retry }));
    await waitFor(() => expect(api.sent('PATCH /api/appointments/a1')).toEqual([{ startsAt: failed.startsAt, endsAt: failed.endsAt }]));
  });

  it('Mark done posts /complete', async () => {
    api = stubApi(routesFor({}));
    const { user } = renderDetail();

    await user.click(await screen.findByRole('button', { name: appointments.markDone }));
    await waitFor(() => expect(api.sent('POST /api/appointments/a1/complete')).toEqual([{}]));
  });

  it('No-show posts /no-show', async () => {
    api = stubApi(routesFor({}));
    const { user } = renderDetail();

    await user.click(await screen.findByRole('button', { name: appointments.noShow }));
    await waitFor(() => expect(api.sent('POST /api/appointments/a1/no-show')).toEqual([{}]));
  });

  it('Cancel asks to confirm then posts /cancel (nothing posted before confirming)', async () => {
    api = stubApi(routesFor({}));
    const { user } = renderDetail();

    await user.click(await screen.findByRole('button', { name: appointments.cancel }));
    expect(await screen.findByText(appointments.cancelConfirm)).toBeTruthy();
    expect(api.count('POST /api/appointments/a1/cancel')).toBe(0);

    await user.click(screen.getByRole('button', { name: appointments.cancelYes }));
    await waitFor(() => expect(api.sent('POST /api/appointments/a1/cancel')).toEqual([{}]));
  });

  it('Reschedule calls onReschedule', async () => {
    api = stubApi(routesFor({}));
    const { user, onReschedule } = renderDetail();

    await user.click(await screen.findByRole('button', { name: appointments.reschedule }));
    expect(onReschedule).toHaveBeenCalledTimes(1);
  });

  it('a viewer who cannot edit sees no action buttons', async () => {
    api = stubApi(routesFor({}));
    renderDetail({ ...APPOINTMENT, canEdit: false });

    expect(await screen.findByRole('heading', { name: 'Roof check' })).toBeTruthy();
    for (const name of [appointments.reschedule, appointments.markDone, appointments.noShow, appointments.cancel]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('useAvailability', () => {
  function wrapper({ children }: { children: ReactNode }) {
    const client = createQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    return <Providers client={client}>{children}</Providers>;
  }

  it('availability url has kind, from, to, userId, propertyId in that order and is skipped for installs', async () => {
    api = stubApi({
      'GET /api/calendar/availability?kind=inspection&from=2026-10-12T05%3A00%3A00.000Z&to=2026-10-26T05%3A00%3A00.000Z&userId=u1&propertyId=p1': () => ({
        body: { slots: [] },
      }),
    });
    const query = { kind: 'inspection' as const, from: '2026-10-12T05:00:00.000Z', to: '2026-10-26T05:00:00.000Z', userId: 'u1', propertyId: 'p1' };
    const { result } = renderHook(() => useAvailability(query), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ slots: [] }));
    expect(api.calls.map((call) => call.url)).toEqual([
      '/api/calendar/availability?kind=inspection&from=2026-10-12T05%3A00%3A00.000Z&to=2026-10-26T05%3A00%3A00.000Z&userId=u1&propertyId=p1',
    ]);

    cleanup();
    vi.unstubAllGlobals();
    api = stubApi({});
    renderHook(() => useAvailability({ ...query, kind: 'install' }), { wrapper });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(api.calls.filter((call) => call.url.includes('availability'))).toEqual([]);
  });
});
