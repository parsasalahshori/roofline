// The company zone is America/Chicago; the test process runs in UTC, so every positioned element proves the zone is used.
vi.hoisted(() => {
  process.env.TZ = 'UTC';
});

import type { AppointmentView } from '@roofline/shared';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyBody, TeamBody } from '../src/api/types.ts';
import { CalendarWindow } from '../src/features/calendar/CalendarWindow.tsx';
import type { AppointmentsBody, BusyBlock } from '../src/features/calendar/types.ts';
import { calendar } from '../src/copy/calendar.ts';
import {
  addZonedDays,
  dateKeyToInstant,
  formatDayLabel,
  formatRangeLabel,
  formatTime,
  minutesIntoDay,
  startOfZonedDay,
  weekStart,
  zonedDateKey,
  zonedParts,
  zoneName,
} from '../src/features/calendar/time.ts';
import { ACCOUNT, renderAt, type Routes, stubApi, where } from './helpers.tsx';

const CHICAGO = 'America/Chicago';
const PHONE_QUERY = '(max-width: 767.98px)';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

describe('time', () => {
  it('zonedParts reads the wall clock of the zone, with Monday as weekday 1', () => {
    expect(zonedParts(new Date('2026-11-02T15:00:00Z'), CHICAGO)).toEqual({
      year: 2026,
      month: 11,
      day: 2,
      hour: 9,
      minute: 0,
      second: 0,
      weekday: 1,
    });
  });

  it('startOfZonedDay and addZonedDays cover the 23-hour day of 2026-03-08 in Chicago', () => {
    const midnight = startOfZonedDay(new Date('2026-03-08T12:00:00Z'), CHICAGO);
    expect(midnight.toISOString()).toBe('2026-03-08T06:00:00.000Z');
    const next = addZonedDays(midnight, 1, CHICAGO);
    expect(next.toISOString()).toBe('2026-03-09T05:00:00.000Z');
    expect(minutesIntoDay(midnight, next)).toBe(23 * 60);
  });

  it('startOfZonedDay and addZonedDays cover the 25-hour day of 2026-11-01 in Chicago', () => {
    const midnight = startOfZonedDay(new Date('2026-11-01T12:00:00Z'), CHICAGO);
    expect(midnight.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    const next = addZonedDays(midnight, 1, CHICAGO);
    expect(next.toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(minutesIntoDay(midnight, next)).toBe(25 * 60);
  });

  it('addZonedDays goes backwards across days', () => {
    expect(addZonedDays(new Date('2026-11-02T15:00:00Z'), -1, CHICAGO).toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  it('weekStart is the Monday of the week, Sunday belonging to the week before', () => {
    expect(weekStart(new Date('2026-11-04T18:00:00Z'), CHICAGO).toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(weekStart(new Date('2026-11-01T18:00:00Z'), CHICAGO).toISOString()).toBe('2026-10-26T05:00:00.000Z');
  });

  it('formatTime gives a short clock time in the zone', () => {
    expect(formatTime(new Date('2026-11-02T15:30:00Z'), CHICAGO)).toBe('9:30 AM');
  });

  it('zonedDateKey and dateKeyToInstant round-trip a zone day', () => {
    expect(zonedDateKey(new Date('2026-11-02T04:30:00Z'), CHICAGO)).toBe('2026-11-01');
    expect(dateKeyToInstant('2026-11-02', CHICAGO).toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(zonedDateKey(dateKeyToInstant('2026-03-08', CHICAGO), CHICAGO)).toBe('2026-03-08');
  });

  it('formatDayLabel and formatRangeLabel name the days in the zone', () => {
    expect(formatDayLabel(new Date('2026-11-02T15:00:00Z'), CHICAGO)).toBe('Mon, Nov 2');
    const from = weekStart(new Date('2026-11-02T15:00:00Z'), CHICAGO);
    const to = addZonedDays(from, 7, CHICAGO);
    expect(formatRangeLabel(from, to, CHICAGO)).toBe('Nov 2 - Nov 8, 2026');
  });

  it('zoneName gives the long name of the zone', () => {
    expect(zoneName(CHICAGO)).toBe('Central Time');
  });
});

/** The company as the server sends it. */
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

/** Two active people: Sam (owner, u1) and Jo (rep, u2). */
const TEAM_BODY: TeamBody = {
  members: [
    { id: 'm1', userId: 'u1', name: 'Sam Roofer', email: 'sam@example.com', role: 'owner', canApproveSpend: true, status: 'active', stormAlertEmail: true },
    { id: 'm2', userId: 'u2', name: 'Jo Crew', email: 'jo@example.com', role: 'rep', canApproveSpend: false, status: 'active', stormAlertEmail: true },
  ],
  invites: [],
};

function makeAppointment(overrides: Partial<AppointmentView> & { id: string }): AppointmentView {
  return {
    kind: 'inspection',
    title: 'Inspection',
    status: 'scheduled',
    startsAt: '2026-11-02T15:00:00.000Z',
    endsAt: '2026-11-02T16:00:00.000Z',
    allDay: false,
    assigned: { userId: 'u1', name: 'Sam Roofer' },
    jobId: null,
    customerId: null,
    customerName: 'Maple Ridge',
    propertyId: null,
    addressLine: null,
    notes: null,
    source: 'manual',
    sync: 'none',
    canEdit: true,
    ...overrides,
  };
}

type CalendarData = { appointments?: AppointmentView[]; busy?: BusyBlock[]; account?: typeof ACCOUNT };

/** matchMedia that answers the phone query with `phone` and everything else with no match. */
function stubViewport(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
}

/**
 * Stubs the calendar's reads. Every GET /api/appointments?… answers the same body; the tests read
 * the query string from `api.calls` instead of matching it here.
 */
function stubCalendar({ appointments = [], busy = [], account = ACCOUNT }: CalendarData = {}) {
  const body: AppointmentsBody = { appointments, busy };
  const routes: Routes = {
    'GET /api/auth/me': () => ({ body: account }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    'GET /api/team': () => ({ body: TEAM_BODY }),
    'POST /api/calendar/sync': () => ({ body: {} }),
  };
  const withAppointments = new Proxy(routes, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key.startsWith('GET /api/appointments?')) return () => ({ body });
      return Reflect.get(target, key, receiver);
    },
  });
  api = stubApi(withAppointments);
  return api;
}

/** The query strings of every appointments read so far, parsed. */
function appointmentReads(): URL[] {
  return api.calls.filter((call) => call.url.startsWith('/api/appointments?')).map((call) => new URL(call.url, 'http://localhost'));
}

function renderCalendar(path: string, data: CalendarData = {}, { phone = false }: { phone?: boolean } = {}) {
  stubViewport(phone);
  stubCalendar(data);
  return renderAt(<CalendarWindow />, path);
}

describe('calendar window', () => {
  it('week renders appointments at the right rows for Chicago while TZ is UTC', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [makeAppointment({ id: 'a1', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T16:00:00.000Z' })],
    });
    const element = await screen.findByTestId('appt-a1');
    // 09:00 is three hours after the 06:00 first row, at 30 minutes a row
    expect(element).toHaveAttribute('data-row-start', '6');
    expect(element).toHaveAttribute('data-row-span', '2');
  });

  it('all-day install spans the row', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({
          id: 'a2',
          kind: 'install',
          title: 'Roof install',
          allDay: true,
          startsAt: '2026-11-02T06:00:00.000Z',
          endsAt: '2026-11-03T06:00:00.000Z',
        }),
      ],
    });
    expect((await screen.findByTestId('allday-a2')).closest('[data-day]')).toHaveAttribute('data-day', '2026-11-02');
  });

  it('multi-day all-day install appears in each day it covers, end exclusive', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({
          id: 'a2',
          kind: 'install',
          title: 'Roof install',
          allDay: true,
          startsAt: '2026-11-02T06:00:00.000Z',
          endsAt: '2026-11-05T06:00:00.000Z',
        }),
      ],
    });
    await screen.findAllByTestId('allday-a2');
    const cells = screen.getAllByTestId('allday-a2').map((el) => el.closest('[data-day]')?.getAttribute('data-day'));
    expect(cells).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
  });

  it('empty slots are reached by pointer, not Tab, and are named by their day and time', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02');
    const slot = await screen.findByTestId('slot-2026-11-02-09:30');
    expect(slot).toHaveAttribute('tabindex', '-1');
    expect(slot).toHaveAccessibleName('Mon, Nov 2 9:30 AM');
  });

  it('busy blocks show Busy', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      busy: [
        { userId: 'u2', start: '2026-11-02T17:00:00.000Z', end: '2026-11-02T18:00:00.000Z', allDay: false },
        { userId: 'u1', start: '2026-11-03T06:00:00.000Z', end: '2026-11-04T06:00:00.000Z', allDay: true },
      ],
    });
    expect(await screen.findByTestId('busy-0')).toHaveTextContent(calendar.busy);
    expect(await screen.findByTestId('busy-1')).toHaveTextContent(calendar.busy);
  });

  it('overlapping appointments share the day column in two lanes', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'a1', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T16:00:00.000Z' }),
        makeAppointment({ id: 'a2', startsAt: '2026-11-02T15:30:00.000Z', endsAt: '2026-11-02T16:30:00.000Z' }),
      ],
    });
    const a1 = await screen.findByTestId('appt-a1');
    const a2 = await screen.findByTestId('appt-a2');
    expect(a1).toHaveAttribute('data-lanes', '2');
    expect(a2).toHaveAttribute('data-lanes', '2');
    expect(a1).toHaveAttribute('data-lane', '0');
    expect(a2).toHaveAttribute('data-lane', '1');
  });

  it('arrow keys move focus between appointments and Enter opens the focused one', async () => {
    const { router, user } = renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'a1', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T16:00:00.000Z' }),
        makeAppointment({ id: 'a2', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T16:00:00.000Z' }),
      ],
    });
    const first = await screen.findByTestId('appt-a1');
    act(() => first.focus());
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('appt-a2')).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/calendar/appointments/a2'));
  });

  it('clicking an appointment opens it', async () => {
    const { router, user } = renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [makeAppointment({ id: 'a1' })],
    });
    await user.click(await screen.findByTestId('appt-a1'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/calendar/appointments/a1'));
  });

  it('syncs the calendar once when it opens', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02');
    await screen.findByTestId('time-grid');
    await waitFor(() => expect(api.count('POST /api/calendar/sync')).toBe(1));
  });

  it('names the company time zone', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02');
    expect(await screen.findByTestId('zone-note')).toHaveTextContent(calendar.zoneNote(zoneName(CHICAGO)));
  });

  it('next, day view and today move the window', async () => {
    const { router, user } = renderCalendar('/calendar?view=week&date=2026-11-02');
    await waitFor(() => expect(appointmentReads().length).toBeGreaterThan(0));
    const params = () => new URL(where(router), 'http://localhost').searchParams;

    await user.click(await screen.findByRole('button', { name: calendar.next }));
    await waitFor(() => expect(params().get('date')).toBe('2026-11-09'));
    await waitFor(() => expect(appointmentReads().at(-1)?.searchParams.get('from')).toBe('2026-11-09T06:00:00.000Z'));

    await user.click(await screen.findByRole('button', { name: calendar.viewDay }));
    await waitFor(() => expect(params().get('view')).toBe('day'));
    await waitFor(() => {
      const read = appointmentReads().at(-1);
      const span = Date.parse(read?.searchParams.get('to') ?? '') - Date.parse(read?.searchParams.get('from') ?? '');
      // Nov 9 has no DST change, so the day is 24 hours
      expect(span).toBe(24 * 60 * 60 * 1000);
    });

    await user.click(await screen.findByRole('button', { name: calendar.today }));
    await waitFor(() => expect(params().get('date')).toBeNull());
  });

  it('empty-slot click goes to the new-appointment URL', async () => {
    const { router, user } = renderCalendar('/calendar?view=week&date=2026-11-02');
    await user.click(await screen.findByTestId('slot-2026-11-02-09:30'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/calendar/new'));
    const params = new URL(where(router), 'http://localhost').searchParams;
    expect(params.get('start')).toBe('2026-11-02T15:30:00.000Z');
    expect(params.get('people')).toContain('u1');
  });

  it('people picker updates the request', async () => {
    const { user } = renderCalendar('/calendar?view=week&date=2026-11-02');
    await waitFor(() => expect(appointmentReads().at(-1)?.searchParams.get('userIds')).toBe('u1,u2'));
    await user.click(await screen.findByRole('checkbox', { name: 'Jo Crew' }));
    await waitFor(() => expect(appointmentReads().at(-1)?.searchParams.get('userIds')).toBe('u1'));
  });

  it('week label names the seven days shown', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02');
    expect(await screen.findByText('Nov 2 - Nov 8, 2026')).toBeInTheDocument();
  });

  it('with nobody picked the appointments are not requested for everyone', async () => {
    const { user } = renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [makeAppointment({ id: 'a1' })],
    });
    expect(await screen.findByTestId('appt-a1')).toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: 'Jo Crew' }));
    await waitFor(() => expect(appointmentReads().at(-1)?.searchParams.get('userIds')).toBe('u1'));
    const readsBefore = appointmentReads().length;
    await user.click(await screen.findByRole('checkbox', { name: 'Sam Roofer' }));
    await waitFor(() => expect(screen.queryByTestId('appt-a1')).toBeNull());
    // Nobody picked: no request may go out without userIds, which the server reads as everyone
    expect(appointmentReads().slice(readsBefore).every((read) => read.searchParams.get('userIds') !== null)).toBe(true);
  });

  it('agenda on phone', async () => {
    const { user } = renderCalendar('/calendar?date=2026-11-02', {
      appointments: [makeAppointment({ id: 'a1' })],
    }, { phone: true });
    expect(await screen.findByTestId('agenda-item-a1')).toBeInTheDocument();
    const firstTo = appointmentReads()[0]?.searchParams.get('to');
    expect(firstTo).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: calendar.loadMore }));
    await waitFor(() => {
      const lastTo = appointmentReads().at(-1)?.searchParams.get('to');
      expect(lastTo).toBeTruthy();
      expect(Date.parse(lastTo ?? '') - Date.parse(firstTo ?? '')).toBe(14 * 24 * 60 * 60 * 1000);
    });
  });

  it('DST week of 2026-11-01 positions', async () => {
    const { router, user } = renderCalendar('/calendar?view=week&date=2026-11-01', {
      // 14:00Z is 08:00 CST, after the change back at 07:00Z
      appointments: [makeAppointment({ id: 'a4', startsAt: '2026-11-01T14:00:00.000Z', endsAt: '2026-11-01T15:00:00.000Z' })],
    });
    expect(await screen.findByTestId('appt-a4')).toHaveAttribute('data-row-start', '4');
    await user.click(await screen.findByTestId('slot-2026-11-01-09:30'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/calendar/new'));
    expect(new URL(where(router), 'http://localhost').searchParams.get('start')).toBe('2026-11-01T15:30:00.000Z');
  });

  it('reps see no people picker', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [makeAppointment({ id: 'a1' })],
      account: { ...ACCOUNT, role: 'rep' },
    });
    expect(await screen.findByTestId('appt-a1')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Jo Crew' })).toBeNull();
    expect(screen.queryByText(calendar.people)).toBeNull();
  });

  it('canceled hidden until Show canceled toggled', async () => {
    const { user } = renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'a1' }),
        makeAppointment({
          id: 'a3',
          status: 'canceled',
          startsAt: '2026-11-03T15:00:00.000Z',
          endsAt: '2026-11-03T16:00:00.000Z',
        }),
      ],
    });
    expect(await screen.findByTestId('appt-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('appt-a3')).toBeNull();
    await user.click(screen.getByRole('switch', { name: calendar.showCanceled }));
    expect(await screen.findByTestId('appt-a3')).toBeInTheDocument();
  });
});
