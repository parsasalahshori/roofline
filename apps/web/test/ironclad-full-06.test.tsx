import type { AppointmentView } from '@roofline/shared';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarWindow } from '../src/features/calendar/CalendarWindow.tsx';
import { AppointmentForm } from '../src/features/appointments/AppointmentForm.tsx';
import { calendar } from '../src/copy/calendar.ts';
import { appointments } from '../src/copy/appointments.ts';
import { ACCOUNT, renderAt, stubApi, type Routes } from './helpers.tsx';

const visit: AppointmentView = {
  id: 'visit', kind: 'inspection', title: 'Inspection', status: 'scheduled',
  startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T15:30:00.000Z', allDay: false,
  assigned: { userId: 'u1', name: 'Sam Roofer' }, jobId: null, customerId: null,
  customerName: 'Maple Ridge', propertyId: null, addressLine: '123 Maple Lane', notes: null,
  source: 'manual', sync: 'none', confirmedAt: null, confirmedVia: null, canEdit: true,
};
const canceled = { ...visit, id: 'canceled', customerName: 'Canceled customer', status: 'canceled' as const };
let api: ReturnType<typeof stubApi>;
function setup({ phone = false, role = 'owner', items = [visit, canceled], failed = false }: {
  phone?: boolean; role?: 'owner' | 'rep'; items?: AppointmentView[]; failed?: boolean;
} = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 767.98px)', media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  const routes: Routes = {
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    'GET /api/company': () => ({ body: { timezone: 'America/Chicago' } }),
    'GET /api/team': () => ({ body: { members: [{ id: 'm1', userId: 'u1', name: 'Sam Roofer', status: 'active' }], invites: [] } }),
    'POST /api/calendar/sync': () => ({ body: {} }),
  };
  api = stubApi(new Proxy(routes, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key.startsWith('GET /api/appointments?')) {
        return () => failed ? { status: 500, body: { error: 'Unavailable' } } : { body: { appointments: items, busy: [] } };
      }
      if (typeof key === 'string' && key.startsWith('GET /api/calendar/availability?')) return () => ({ body: { slots: [] } });
      return Reflect.get(target, key, receiver);
    },
  }));
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api.unexpected).toEqual([]);
});

describe('Ironclad calendar presentation preserves scheduling', () => {
  it('uses the filtered real result for the sidebar and opens the existing appointment route', async () => {
    setup();
    const { user, router } = renderAt(<CalendarWindow />, '/calendar?view=week&date=2026-11-02');
    const summary = await screen.findByRole('complementary', { name: calendar.inView });
    expect(await within(summary).findByText('1 appointment')).toBeInTheDocument();
    expect(within(summary).queryByText('Canceled customer')).toBeNull();
    await user.click(within(summary).getByRole('button', { name: /Maple Ridge/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/calendar/appointments/visit'));
  });

  it('updates the sidebar with canceled visibility and clears it when no people are selected', async () => {
    setup();
    const { user } = renderAt(<CalendarWindow />, '/calendar?view=week&date=2026-11-02');
    const summary = await screen.findByRole('complementary', { name: calendar.inView });
    await within(summary).findByText('1 appointment');
    await user.click(screen.getByRole('switch', { name: calendar.showCanceled }));
    expect(within(summary).getByText('2 appointments')).toBeInTheDocument();
    expect(within(summary).getByText('Canceled customer')).toBeInTheDocument();
    const callsBeforeClearing = api.calls.length;
    await user.click(screen.getByRole('checkbox', { name: 'Sam Roofer' }));
    expect(await within(summary).findByText(calendar.noPeople)).toBeInTheDocument();
    expect(within(summary).queryByText('Maple Ridge')).toBeNull();
    expect(api.calls.slice(callsBeforeClearing).filter((call) => call.url.startsWith('/api/appointments?'))).toEqual([]);
  });

  it('keeps people and date deep links when moving from the summary to the full list', async () => {
    setup({ role: 'rep' });
    const { user, router } = renderAt(<CalendarWindow />, '/calendar?view=week&date=2026-11-02&people=u1');
    await user.click(await screen.findByRole('button', { name: calendar.moreInView }));
    await waitFor(() => expect(router.state.location.search).toContain('view=list'));
    expect(router.state.location.search).toContain('date=2026-11-02');
    expect(router.state.location.search).toContain('people=u1');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(await screen.findByTestId('agenda-item-visit')).toBeInTheDocument();
  });

  it('gives a short grid appointment a complete accessible name in company time', async () => {
    setup({ items: [visit] });
    renderAt(<CalendarWindow />, '/calendar?view=week&date=2026-11-02');
    expect(await screen.findByTestId('appt-visit')).toHaveAccessibleName('Inspection · Maple Ridge · 9:00 AM - 9:30 AM · 123 Maple Lane');
  });

  it('shows address, assignee and explicit status in the phone agenda without a duplicate sidebar', async () => {
    setup({ phone: true, items: [visit] });
    const { user, router } = renderAt(<CalendarWindow />, '/calendar?date=2026-11-02');
    const row = await screen.findByTestId('agenda-item-visit');
    expect(row).toHaveTextContent('123 Maple Lane');
    expect(row).toHaveTextContent('Sam Roofer');
    expect(row).toHaveTextContent('Scheduled');
    expect(screen.queryByRole('complementary')).toBeNull();
    await user.click(screen.getByText(calendar.selectedPeople(1)));
    expect(screen.getByRole('checkbox', { name: 'Sam Roofer' })).toBeVisible();
    await user.click(row);
    await waitFor(() => expect(router.state.location.pathname).toBe('/calendar/appointments/visit'));
  });

  it('does not present a failed read as an empty successful count', async () => {
    setup({ failed: true });
    renderAt(<CalendarWindow />, '/calendar?view=week&date=2026-11-02');
    const summary = await screen.findByRole('complementary', { name: calendar.inView });
    expect(await within(summary).findByText(calendar.loadError)).toBeInTheDocument();
    expect(within(summary).queryByText('0 appointments')).toBeNull();
  });

  it('explains company time beside the appointment fields without changing the slot prefill', async () => {
    setup();
    renderAt(<AppointmentForm onDone={vi.fn()} />, '/calendar/new?start=2026-11-02T15%3A30%3A00.000Z');
    expect(await screen.findByText(appointments.timeZone('Central Time'))).toBeInTheDocument();
    expect(screen.getByLabelText(appointments.dateLabel)).toHaveValue('2026-11-02');
    expect(screen.getByLabelText(appointments.timeLabel)).toHaveValue('09:30');
  });
});
