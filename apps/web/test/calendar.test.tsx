// The company zone is America/Chicago; the test process runs in UTC, so every positioned element proves the zone is used.
vi.hoisted(() => {
  process.env.TZ = 'UTC';
});

import type { AppointmentView } from '@roofline/shared';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyBody, TeamBody } from '../src/api/types.ts';
import { AgendaView } from '../src/features/calendar/AgendaView.tsx';
import { CalendarWindow } from '../src/features/calendar/CalendarWindow.tsx';
import { colorFor, colorOfAppointment, kindColor, PERSON_COLORS } from '../src/features/calendar/colors.ts';
import type { AppointmentsBody, BusyBlock } from '../src/features/calendar/types.ts';
import { visitKind } from '../src/features/calendar/visit.ts';
import { calendar } from '../src/copy/calendar.ts';
import {
  addZonedDays,
  dateKeyToInstant,
  formatCompactRange,
  formatCompactTime,
  formatDayLabel,
  formatDayNumber,
  formatRangeLabel,
  formatTime,
  formatWeekday,
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

  it('formatWeekday and formatDayNumber read the day head of the grid in the zone', () => {
    // 04:30Z is still the evening of Sunday Nov 1 in Chicago
    expect(formatWeekday(new Date('2026-11-02T04:30:00Z'), CHICAGO)).toBe('Sun');
    expect(formatDayNumber(new Date('2026-11-02T04:30:00Z'), CHICAGO)).toBe('1');
    expect(formatWeekday(new Date('2026-11-02T15:00:00Z'), CHICAGO)).toBe('Mon');
    expect(formatDayNumber(new Date('2026-11-02T15:00:00Z'), CHICAGO)).toBe('2');
  });

  it('zoneName gives the long name of the zone', () => {
    expect(zoneName(CHICAGO)).toBe('Central Time');
  });

  it('formatCompactRange and formatCompactTime write the hours in as few characters as read clearly', () => {
    // 14:00Z is 8:00 AM in Chicago in November
    expect(formatCompactRange(new Date('2026-11-02T14:00:00Z'), new Date('2026-11-02T17:00:00Z'), CHICAGO)).toBe('8 - 11 AM');
    expect(formatCompactRange(new Date('2026-11-02T14:30:00Z'), new Date('2026-11-02T15:30:00Z'), CHICAGO)).toBe('8:30 - 9:30 AM');
    expect(formatCompactRange(new Date('2026-11-02T17:00:00Z'), new Date('2026-11-02T19:30:00Z'), CHICAGO)).toBe('11 AM - 1:30 PM');
    expect(formatCompactTime(new Date('2026-11-02T15:00:00Z'), CHICAGO)).toBe('9 AM');
    expect(formatCompactTime(new Date('2026-11-02T15:30:00Z'), CHICAGO)).toBe('9:30 AM');
  });
});

describe('visit names', () => {
  it('keeps the kind of visit, and leaves the customer to a line of its own', () => {
    expect(visitKind('Roof inspection: Kevin Hall', 'Kevin Hall')).toBe('Roof inspection');
    expect(visitKind('Window install: Beverly Stroud', 'Beverly Stroud')).toBe('Window install');
  });

  it('leaves a title whole when it does not end with its customer', () => {
    expect(visitKind('Roof inspection for the clubhouse', 'Maple Ridge HOA')).toBe('Roof inspection for the clubhouse');
    expect(visitKind('Roof inspection: Kevin Hall', 'Someone Else')).toBe('Roof inspection: Kevin Hall');
    expect(visitKind('Roof inspection', null)).toBe('Roof inspection');
    expect(visitKind(': Kevin Hall', 'Kevin Hall')).toBe(': Kevin Hall');
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
    confirmedAt: null,
    confirmedVia: null,
    canEdit: true,
    ...overrides,
  };
}

type CalendarData = {
  appointments?: AppointmentView[];
  busy?: BusyBlock[];
  account?: typeof ACCOUNT;
  /** How many of the first appointment reads answer with a server error. */
  failReads?: number;
};

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
function stubCalendar({ appointments = [], busy = [], account = ACCOUNT, failReads = 0 }: CalendarData = {}) {
  const body: AppointmentsBody = { appointments, busy };
  let failures = failReads;
  const routes: Routes = {
    'GET /api/auth/me': () => ({ body: account }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    'GET /api/team': () => ({ body: TEAM_BODY }),
    'POST /api/calendar/sync': () => ({ body: {} }),
  };
  const withAppointments = new Proxy(routes, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key.startsWith('GET /api/appointments?')) {
        return () => (failures-- > 0 ? { status: 500, body: { error: 'The calendar is down.' } } : { body });
      }
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

    await user.click(await screen.findByRole('radio', { name: calendar.viewDay }));
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
    const jo = await screen.findByRole('button', { name: 'Jo Crew' });
    expect(jo).toHaveAttribute('aria-pressed', 'true');
    await user.click(jo);
    await waitFor(() => expect(appointmentReads().at(-1)?.searchParams.get('userIds')).toBe('u1'));
    expect(screen.getByRole('button', { name: 'Jo Crew' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Sam Roofer' })).toHaveAttribute('aria-pressed', 'true');
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
    await user.click(await screen.findByRole('button', { name: 'Jo Crew' }));
    await waitFor(() => expect(appointmentReads().at(-1)?.searchParams.get('userIds')).toBe('u1'));
    const readsBefore = appointmentReads().length;
    await user.click(await screen.findByRole('button', { name: 'Sam Roofer' }));
    await waitFor(() => expect(screen.queryByTestId('appt-a1')).toBeNull());
    // Nobody picked: no request may go out without userIds, which the server reads as everyone
    expect(appointmentReads().slice(readsBefore).every((read) => read.searchParams.get('userIds') !== null)).toBe(true);
  });

  it('the list on a phone loads another fortnight on Load more', async () => {
    const { user } = renderCalendar('/calendar?view=list&date=2026-11-02', {
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
    expect(screen.queryByRole('button', { name: 'Jo Crew' })).toBeNull();
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
    // The server leaves canceled visits out unless asked: the switch asks for them
    expect(appointmentReads().every((read) => read.searchParams.get('includeCanceled') === null)).toBe(true);
    await user.click(screen.getByRole('switch', { name: calendar.showCanceled }));
    expect(await screen.findByTestId('appt-a3')).toBeInTheDocument();
    expect(appointmentReads().at(-1)?.searchParams.get('includeCanceled')).toBe('true');
  });
});

describe('calendar window, as redesigned', () => {
  it('the controls are a radio group for the view, ghost buttons for the steps and a primary New appointment', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02');
    const views = await screen.findByRole('radiogroup', { name: calendar.viewLabel });
    expect(within(views).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([calendar.viewDay, calendar.viewWeek, calendar.viewList]);
    expect(within(views).getByRole('radio', { name: calendar.viewWeek })).toBeChecked();
    for (const name of [calendar.today, calendar.previous, calendar.next]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: calendar.newAppointment })).toHaveAttribute('href', '/calendar/new');
  });

  it('the people are chips with a colour dot, grouped under a name', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02');
    const group = await screen.findByRole('group', { name: calendar.peopleLabel });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Sam Roofer', 'Jo Crew']);
    expect(chips.every((chip) => chip.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(chips[0]?.querySelector('span[style]')?.getAttribute('style')).toContain(PERSON_COLORS[0]);
    expect(chips[1]?.querySelector('span[style]')?.getAttribute('style')).toContain(PERSON_COLORS[1]);
  });

  it('a block takes its edge from the person, tells its whole text on hover and is one line when it is 30 minutes', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'a1', title: 'Roof inspection for the Maple Ridge HOA clubhouse', customerName: 'Maple Ridge HOA' }),
        makeAppointment({
          id: 'a2',
          title: 'Quick look',
          assigned: { userId: 'u2', name: 'Jo Crew' },
          startsAt: '2026-11-03T15:00:00.000Z',
          endsAt: '2026-11-03T15:30:00.000Z',
        }),
        makeAppointment({ id: 'a3', kind: 'install', title: 'Tear-off', assigned: null, startsAt: '2026-11-04T15:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z' }),
      ],
    });
    const tall = await screen.findByTestId('appt-a1');
    expect(tall).toHaveAttribute('data-size', 'tall');
    expect(tall).toHaveAttribute('title', 'Roof inspection for the Maple Ridge HOA clubhouse · Maple Ridge HOA · 9:00 AM - 10:00 AM · Sam Roofer');
    expect(tall.style.getPropertyValue('--person')).toBe(colorFor(0));
    const short = screen.getByTestId('appt-a2');
    expect(short).toHaveAttribute('data-size', 'short');
    expect(short).toHaveAttribute('data-row-span', '1');
    expect(short.style.getPropertyValue('--person')).toBe(colorFor(1));
    // Nobody shown is on it, so its kind gives the colour
    expect(screen.getByTestId('appt-a3').style.getPropertyValue('--person')).toBe(kindColor('install'));
  });

  it('a canceled block is struck and says so aloud once it is shown', async () => {
    const { user } = renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [makeAppointment({ id: 'a3', status: 'canceled', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T16:00:00.000Z' })],
    });
    await user.click(await screen.findByRole('switch', { name: calendar.showCanceled }));
    const block = await screen.findByTestId('appt-a3');
    expect(block).toHaveAttribute('data-status', 'canceled');
    expect(within(block).getByText(calendar.status.canceled)).toBeInTheDocument();
  });

  it('the line for the time now is in the column of today, and the head of that day is marked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T16:30:00.000Z'));
    try {
      renderCalendar('/calendar?view=week&date=2026-11-02');
      const line = await screen.findByTestId('now-line');
      expect(line.closest('[data-day]')).toHaveAttribute('data-day', '2026-11-04');
      const marked = Array.from(document.querySelectorAll('[data-testid="time-grid"] [data-today="true"]'));
      expect(marked.length).toBeGreaterThan(0);
      expect(marked.every((element) => element.getAttribute('data-day') === '2026-11-04')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no line for now when today is not in the week shown', async () => {
    renderCalendar('/calendar?view=week&date=2020-03-02');
    await screen.findByTestId('time-grid');
    expect(screen.queryByTestId('now-line')).toBeNull();
  });

  it('the grid has the hours down its side, and a row for all-day visits only when a day shown has one', async () => {
    renderCalendar('/calendar?view=day&date=2026-11-02');
    const grid = await screen.findByTestId('time-grid');
    expect(within(grid).getByText('9:00 AM')).toBeInTheDocument();
    expect(within(grid).getByText('1:00 PM')).toBeInTheDocument();
    expect(new Set(Array.from(grid.querySelectorAll('[data-day]')).map((cell) => cell.getAttribute('data-day')))).toEqual(new Set(['2026-11-02']));
    // Nothing all-day: no row for it
    expect(within(grid).queryByText(calendar.allDay)).toBeNull();
  });

  it('an all-day visit brings the all-day row, in the column of its day', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'a2', kind: 'install', title: 'Roof install', allDay: true, startsAt: '2026-11-02T06:00:00.000Z', endsAt: '2026-11-03T06:00:00.000Z' }),
      ],
    });
    const grid = await screen.findByTestId('time-grid');
    expect(await within(grid).findByText(calendar.allDay)).toBeInTheDocument();
    expect(within(grid).getByTestId('allday-a2').closest('[data-day]')).toHaveAttribute('data-day', '2026-11-02');
  });

  it('a busy block that lasts all day brings the all-day row too', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      busy: [{ userId: 'u1', start: '2026-11-03T06:00:00.000Z', end: '2026-11-04T06:00:00.000Z', allDay: true }],
    });
    const grid = await screen.findByTestId('time-grid');
    expect(await within(grid).findByText(calendar.allDay)).toBeInTheDocument();
  });

  it('asks for appointments only once the team is known, so no read goes out without people', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02');
    await screen.findByTestId('time-grid');
    expect(appointmentReads().length).toBeGreaterThan(0);
    expect(appointmentReads().every((read) => read.searchParams.get('userIds') === 'u1,u2')).toBe(true);
  });

  it('shows the shape of the grid while the page loads, then the grid', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02');
    expect(screen.getByRole('status', { name: calendar.gridLabel })).toBeInTheDocument();
    expect(await screen.findByTestId('time-grid')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: calendar.gridLabel })).toBeNull();
  });

  it('a failed read says so inline and Try again reads again', async () => {
    const { user } = renderCalendar('/calendar?view=week&date=2026-11-02', { failReads: 1, appointments: [makeAppointment({ id: 'a1' })] });
    const alert = (await screen.findByText(calendar.loadError)).closest<HTMLElement>('[role="alert"]');
    expect(alert).not.toBeNull();
    await user.click(within(alert!).getByRole('button', { name: calendar.tryAgain }));
    expect(await screen.findByTestId('appt-a1')).toBeInTheDocument();
    expect(screen.queryByText(calendar.loadError)).toBeNull();
  });

  it('a phone opens on the day, with the days of its week in a strip a thumb can reach', async () => {
    const { router, user } = renderCalendar(
      '/calendar?date=2026-11-04',
      { appointments: [makeAppointment({ id: 'a1', startsAt: '2026-11-04T15:00:00.000Z', endsAt: '2026-11-04T16:00:00.000Z' })] },
      { phone: true },
    );
    const strip = await screen.findByRole('group', { name: calendar.dayStripLabel });
    const days = within(strip).getAllByRole('button');
    expect(days.map((day) => day.getAttribute('aria-label'))).toEqual([
      'Mon, Nov 2',
      'Tue, Nov 3',
      'Wed, Nov 4',
      'Thu, Nov 5',
      'Fri, Nov 6',
      'Sat, Nov 7',
      'Sun, Nov 8',
    ]);
    expect(days[2]).toHaveAttribute('aria-pressed', 'true');
    expect(days[0]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('radio', { name: calendar.viewDay })).toBeChecked();
    expect(await screen.findByTestId('appt-a1')).toBeInTheDocument();

    await user.click(days[4]!);
    await waitFor(() => expect(new URL(where(router), 'http://localhost').searchParams.get('date')).toBe('2026-11-06'));
    expect(screen.getByRole('button', { name: 'Fri, Nov 6' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the strip is only for the day view on a phone', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-04');
    await screen.findByTestId('time-grid');
    expect(screen.queryByRole('group', { name: calendar.dayStripLabel })).toBeNull();
  });

  it('the list is a panel for each day with a table of its visits, and a tag for one that is not simply scheduled', async () => {
    const { router, user } = renderCalendar('/calendar?view=list&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'a1', title: 'Roof check', addressLine: '412 Maple Ridge Dr' }),
        makeAppointment({ id: 'a2', title: 'Gutter walk', status: 'completed', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T16:00:00.000Z', assigned: null, customerName: null }),
      ],
    });
    const first = await screen.findByTestId('agenda-day-2026-11-02');
    expect(within(first).getByRole('heading', { name: 'Mon, Nov 2' })).toBeInTheDocument();
    expect(within(first).getByText(calendar.count(1))).toBeInTheDocument();
    for (const name of Object.values(calendar.columns)) {
      expect(within(first).getByRole('columnheader', { name })).toBeInTheDocument();
    }
    expect(within(first).getByText('9:00 AM')).toBeInTheDocument();
    expect(within(first).getByText('412 Maple Ridge Dr')).toBeInTheDocument();
    expect(within(first).getByText('Sam Roofer')).toBeInTheDocument();
    // A scheduled visit has no status tag
    expect(within(first).queryByText(calendar.status.scheduled)).toBeNull();

    const second = screen.getByTestId('agenda-day-2026-11-03');
    expect(within(second).getByText(calendar.status.completed)).toBeInTheDocument();
    expect(within(second).getByText(calendar.unassigned)).toBeInTheDocument();
    expect(within(second).getByText(calendar.noCustomer)).toBeInTheDocument();

    // The row opens it, and so does its name; each once
    await user.click(within(first).getByText('9:00 AM'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/calendar/appointments/a1'));
  });

  it('the list has a status column only when a visit shown is not simply scheduled, and then in every day', async () => {
    renderCalendar('/calendar?view=list&date=2026-11-02', { appointments: [makeAppointment({ id: 'a1' })] });
    const only = await screen.findByTestId('agenda-day-2026-11-02');
    expect(within(only).queryByRole('columnheader', { name: calendar.columns.status })).toBeNull();
    cleanup();

    renderCalendar('/calendar?view=list&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'a1' }),
        makeAppointment({ id: 'a2', status: 'no_show', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T16:00:00.000Z' }),
      ],
    });
    for (const day of ['2026-11-02', '2026-11-03']) {
      const panel = await screen.findByTestId(`agenda-day-${day}`);
      expect(within(panel).getByRole('columnheader', { name: calendar.columns.status })).toBeInTheDocument();
    }
    expect(screen.getByText(calendar.status.no_show)).toBeInTheDocument();
  });

  it('on a phone the list is a row for each visit, with its time, where and who, and no table', async () => {
    renderCalendar(
      '/calendar?view=list&date=2026-11-02',
      { appointments: [makeAppointment({ id: 'a1', title: 'Roof check', addressLine: '412 Maple Ridge Dr', status: 'completed' })] },
      { phone: true },
    );
    const day = await screen.findByTestId('agenda-day-2026-11-02');
    expect(within(day).queryByRole('table')).toBeNull();
    const row = within(day).getByRole('listitem');
    expect(row).toHaveTextContent('9:00 AM');
    expect(row).toHaveTextContent('Maple Ridge · 412 Maple Ridge Dr');
    expect(within(row).getByText('Sam Roofer')).toBeInTheDocument();
    expect(within(row).getByText(calendar.status.completed)).toBeInTheDocument();
    expect(within(row).getByTestId('agenda-item-a1')).toHaveTextContent('Roof check');
  });

  it('the list marks the panel of today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T16:30:00.000Z'));
    try {
      renderCalendar('/calendar?view=list&date=2026-11-02', { appointments: [makeAppointment({ id: 'a1' })] });
      const today = await screen.findByTestId('agenda-day-2026-11-02');
      expect(within(today).getByText(calendar.todayTag)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('nothing scheduled shows the sentence, the next action and the shape of the rows', async () => {
    renderCalendar('/calendar?view=list&date=2026-11-02');
    expect(await screen.findByText(calendar.empty)).toBeInTheDocument();
    expect(screen.getByText(calendar.emptyHint)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: calendar.newAppointment })).toHaveLength(2);
  });
});

describe('colours of the calendar', () => {
  it('colorFor gives each person in team order a palette colour and starts again after the eighth', () => {
    expect(PERSON_COLORS).toHaveLength(8);
    expect(colorFor(0)).toBe('var(--st-lead)');
    expect(colorFor(7)).toBe('var(--hail-5)');
    expect(colorFor(8)).toBe(colorFor(0));
  });

  it('an appointment takes the colour of its person, else the colour of its kind, and never red', () => {
    const sam = { userId: 'u1', name: 'Sam Roofer', color: colorFor(0) };
    expect(colorOfAppointment(makeAppointment({ id: 'x' }), [sam])).toBe(colorFor(0));
    expect(colorOfAppointment(makeAppointment({ id: 'y', assigned: { userId: 'u9', name: 'Gone' } }), [sam])).toBe(kindColor('inspection'));
    for (const kind of ['inspection', 'install', 'adjuster', 'other'] as const) {
      expect(kindColor(kind)).not.toMatch(/bad/);
    }
  });
});

describe('Agenda view range overlap', () => {
  const from = dateKeyToInstant('2026-11-03', CHICAGO);
  const view = (items: AppointmentView[]) =>
    render(
      <AgendaView zone={CHICAGO} from={from} dayCount={3} appointments={items} people={[]} showCanceled={false} onOpen={vi.fn()} onLoadMore={vi.fn()} />,
    );

  it('lists a multi-day install on each listed day it covers, from the first listed day', () => {
    view([
      makeAppointment({
        id: 'inst',
        kind: 'install',
        allDay: true,
        startsAt: dateKeyToInstant('2026-11-02', CHICAGO).toISOString(),
        endsAt: dateKeyToInstant('2026-11-05', CHICAGO).toISOString(),
      }),
    ]);
    // Covers 11-02, 11-03, 11-04: the 11-02 day is before the range
    expect(screen.queryByTestId('agenda-day-2026-11-02')).toBeNull();
    expect(screen.getByTestId('agenda-day-2026-11-03')).toBeInTheDocument();
    expect(screen.getByTestId('agenda-day-2026-11-04')).toBeInTheDocument();
    expect(screen.queryByTestId('agenda-day-2026-11-05')).toBeNull();
    expect(screen.getAllByTestId('agenda-item-inst')).toHaveLength(2);
  });

  it('puts a timed item that started before the range on the first listed day', () => {
    view([makeAppointment({ id: 'early', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-03T15:00:00.000Z' })]);
    expect(screen.getByTestId('agenda-day-2026-11-03')).toBeInTheDocument();
    expect(screen.getAllByTestId('agenda-item-early')).toHaveLength(1);
  });
});


describe('calendar blocks', () => {
  it('a done visit says so on its block with a glyph and the word, a no-show too', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'done', status: 'completed', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T16:00:00.000Z' }),
        makeAppointment({ id: 'missed', status: 'no_show', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T16:00:00.000Z' }),
        makeAppointment({ id: 'plain', startsAt: '2026-11-04T15:00:00.000Z', endsAt: '2026-11-04T16:00:00.000Z' }),
      ],
    });
    const done = await screen.findByTestId('appt-done');
    expect(within(done).getByText(calendar.status.completed)).toBeInTheDocument();
    expect(done.querySelector('svg')).not.toBeNull();
    const missed = screen.getByTestId('appt-missed');
    expect(within(missed).getByText(calendar.status.no_show)).toBeInTheDocument();
    expect(missed.querySelector('svg')).not.toBeNull();
    // A visit that is simply scheduled wears no mark
    const plain = screen.getByTestId('appt-plain');
    expect(plain.querySelector('svg')).toBeNull();
    expect(within(plain).queryByText(calendar.status.scheduled)).toBeNull();
  });

  it('keeps the word of the mark where the block has room and only the glyph where it has not, and the pointer always finds it', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'alone', status: 'completed', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T16:00:00.000Z' }),
        makeAppointment({ id: 'p1', status: 'completed', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T16:00:00.000Z' }),
        makeAppointment({ id: 'p2', startsAt: '2026-11-02T15:30:00.000Z', endsAt: '2026-11-02T16:30:00.000Z' }),
      ],
    });
    const alone = await screen.findByTestId('appt-alone');
    expect(within(alone).getByText(calendar.status.completed).closest('[data-word]')).toHaveAttribute('data-word', 'true');
    const side = screen.getByTestId('appt-p1');
    expect(within(side).getByText(calendar.status.completed).closest('[data-word]')).toHaveAttribute('data-word', 'false');
    // Dropped from the sight, not from the page: the word is still there to read aloud, and what the pointer finds says it
    expect(within(side).getByText(calendar.status.completed)).toBeInTheDocument();
    expect(side.getAttribute('title')).toMatch(/ · Done$/);
    // A visit that is simply scheduled has nothing to add to what the pointer finds
    expect(screen.getByTestId('appt-p2').getAttribute('title')).not.toMatch(/Done|Canceled|No-show/);
  });

  it('a short done visit and an all-day one carry the mark too', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'quick', status: 'completed', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T15:30:00.000Z' }),
        makeAppointment({ id: 'days', kind: 'install', status: 'completed', allDay: true, startsAt: '2026-11-03T06:00:00.000Z', endsAt: '2026-11-04T06:00:00.000Z' }),
      ],
    });
    expect(within(await screen.findByTestId('appt-quick')).getByText(calendar.status.completed)).toBeInTheDocument();
    expect(within(screen.getByTestId('allday-days')).getByText(calendar.status.completed)).toBeInTheDocument();
  });

  it('the first line is the kind of visit and the customer has the next, so the name is not cut in the middle', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [makeAppointment({ id: 'k1', title: 'Roof inspection: Kevin Hall', customerName: 'Kevin Hall' })],
    });
    const block = await screen.findByTestId('appt-k1');
    expect(within(block).getByText('Roof inspection')).toBeInTheDocument();
    expect(within(block).getByText('Kevin Hall')).toBeInTheDocument();
    expect(within(block).queryByText('Roof inspection: Kevin Hall')).toBeNull();
    // What the pointer finds does not say the name twice
    expect(block).toHaveAttribute('title', 'Roof inspection · Kevin Hall · 9:00 AM - 10:00 AM · Sam Roofer');
  });

  it('side by side the hours are written shorter, then only the start, and alone they are whole', async () => {
    renderCalendar('/calendar?view=week&date=2026-11-02', {
      appointments: [
        makeAppointment({ id: 'alone', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T16:00:00.000Z' }),
        makeAppointment({ id: 'p1', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T16:00:00.000Z' }),
        makeAppointment({ id: 'p2', startsAt: '2026-11-02T15:30:00.000Z', endsAt: '2026-11-02T16:30:00.000Z' }),
        makeAppointment({ id: 't1', startsAt: '2026-11-04T15:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z' }),
        makeAppointment({ id: 't2', startsAt: '2026-11-04T15:30:00.000Z', endsAt: '2026-11-04T17:00:00.000Z' }),
        makeAppointment({ id: 't3', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z' }),
      ],
    });
    expect(within(await screen.findByTestId('appt-alone')).getByText('9:00 AM - 10:00 AM')).toBeInTheDocument();
    expect(within(screen.getByTestId('appt-p1')).getByText('9 - 10 AM')).toBeInTheDocument();
    expect(within(screen.getByTestId('appt-p2')).getByText('9:30 - 10:30 AM')).toBeInTheDocument();
    expect(screen.getByTestId('appt-t1')).toHaveAttribute('data-lanes', '3');
    expect(within(screen.getByTestId('appt-t1')).getByText('9 AM')).toBeInTheDocument();
    expect(within(screen.getByTestId('appt-t2')).getByText('9:30 AM')).toBeInTheDocument();
    // The pointer still finds the whole range
    expect(screen.getByTestId('appt-p1').getAttribute('title')).toContain('9:00 AM - 10:00 AM');
  });
});

describe('hours that fit the block', () => {
  /** The grid is `px` wide: jsdom does no layout, so the width the grid measures is set here. */
  function gridWidth(px: number) {
    return vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'time-grid' ? px : 0;
    });
  }

  const pair = [
    makeAppointment({ id: 'one', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T16:00:00.000Z' }),
    makeAppointment({ id: 'p1', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T16:00:00.000Z' }),
    makeAppointment({ id: 'p2', startsAt: '2026-11-02T15:30:00.000Z', endsAt: '2026-11-02T16:30:00.000Z' }),
  ];

  it('a narrow week writes a lone block shorter, and a block side by side with only its start, or with no time when even that does not fit', async () => {
    const width = gridWidth(1000);
    try {
      renderCalendar('/calendar?view=week&date=2026-11-02', { appointments: pair });
      // 1000px is a 132px column: 15 characters of mono fit, so "9:00 AM - 10:00 AM" (18) does not, "9 - 10 AM" does
      expect(within(await screen.findByTestId('appt-one')).getByText('9 - 10 AM')).toBeInTheDocument();
      // Two lanes of 66px fit 6 characters: "9 AM" does
      expect(within(screen.getByTestId('appt-p1')).getByText('9 AM')).toBeInTheDocument();
      // "9:30 AM" (7) does not: the time is left out rather than cut in the middle, and the pointer still finds it
      const p2 = screen.getByTestId('appt-p2');
      expect(within(p2).queryByText(/9:30/)).toBeNull();
      expect(p2.getAttribute('title')).toContain('9:30 AM - 10:30 AM');
    } finally {
      width.mockRestore();
    }
  });

  it('a wide week writes every block whole, even side by side', async () => {
    const width = gridWidth(2400);
    try {
      renderCalendar('/calendar?view=week&date=2026-11-02', { appointments: pair });
      expect(within(await screen.findByTestId('appt-one')).getByText('9:00 AM - 10:00 AM')).toBeInTheDocument();
      expect(within(screen.getByTestId('appt-p1')).getByText('9:00 AM - 10:00 AM')).toBeInTheDocument();
      expect(within(screen.getByTestId('appt-p2')).getByText('9:30 AM - 10:30 AM')).toBeInTheDocument();
    } finally {
      width.mockRestore();
    }
  });
});

describe('the status glyph in a narrow block', () => {
  function gridWidth(px: number) {
    return vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'time-grid' ? px : 0;
    });
  }
  /** The first line of a tall block: the kind of visit (and, when there is room, the mark). */
  const headOf = (block: HTMLElement) => block.firstElementChild as HTMLElement;

  it('sits beside the kind where the block has room for both, and under it where the kind would be cut to a letter', async () => {
    const width = gridWidth(1000);
    try {
      renderCalendar('/calendar?view=week&date=2026-11-02', {
        appointments: [
          makeAppointment({ id: 'alone', status: 'completed', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T16:00:00.000Z' }),
          makeAppointment({ id: 'p1', status: 'no_show', startsAt: '2026-11-02T15:00:00.000Z', endsAt: '2026-11-02T16:00:00.000Z' }),
          makeAppointment({ id: 'p2', startsAt: '2026-11-02T15:30:00.000Z', endsAt: '2026-11-02T16:30:00.000Z' }),
        ],
      });
      // A 132px column holds the kind and the mark of a lone block on one line
      const alone = await screen.findByTestId('appt-alone');
      expect(within(headOf(alone)).getByText(calendar.status.completed)).toBeInTheDocument();
      // Two lanes of 66px leave 45px for the words: the kind has the line, the mark has the one after the customer
      const side = screen.getByTestId('appt-p1');
      expect(within(headOf(side)).queryByText(calendar.status.no_show)).toBeNull();
      expect(within(side).getByText(calendar.status.no_show)).toBeInTheDocument();
      expect(within(headOf(side)).getByText('Inspection')).toBeInTheDocument();
    } finally {
      width.mockRestore();
    }
  });
});

describe('where the grid opens', () => {
  /** Records the scrollTop the grid is given: jsdom does not scroll, so the value set is the answer. */
  function recordScroll(): { latest: () => number | undefined; restore: () => void } {
    let value: number | undefined;
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get: () => value ?? 0,
      set: (next: number) => {
        value = next;
      },
    });
    return {
      latest: () => value,
      restore: () => {
        if (original) Object.defineProperty(Element.prototype, 'scrollTop', original);
        else delete (Element.prototype as { scrollTop?: number }).scrollTop;
      },
    };
  }

  it('opens at the first visit of the week when the clock is already past it, so a tall visit shows its name', async () => {
    const scroll = recordScroll();
    vi.useFakeTimers({ toFake: ['Date'] });
    // Wednesday 8:00 PM in Chicago; Tuesday has a 9:00 AM visit, which is row 6: the grid opens one row above it
    vi.setSystemTime(new Date('2026-11-05T02:00:00.000Z'));
    try {
      renderCalendar('/calendar?view=week&date=2026-11-02', {
        appointments: [makeAppointment({ id: 'early', startsAt: '2026-11-03T15:00:00.000Z', endsAt: '2026-11-03T21:00:00.000Z' })],
      });
      await screen.findByTestId('appt-early');
      await waitFor(() => expect(scroll.latest()).toBe(5 * 32));
    } finally {
      vi.useRealTimers();
      scroll.restore();
    }
  });

  it('opens a few rows above the clock when no visit is earlier, and keeps the clock in view when the first visit is later', async () => {
    const scroll = recordScroll();
    vi.useFakeTimers({ toFake: ['Date'] });
    // Wednesday 8:00 PM, nothing on the grid: three rows above the clock's row (28)
    vi.setSystemTime(new Date('2026-11-05T02:00:00.000Z'));
    try {
      renderCalendar('/calendar?view=week&date=2026-11-02');
      await screen.findByTestId('time-grid');
      await waitFor(() => expect(scroll.latest()).toBe(25 * 32));
      cleanup();
      // Wednesday 9:00 AM with the first visit at 2:00 PM: the clock leads, so it stays in view
      vi.setSystemTime(new Date('2026-11-04T15:00:00.000Z'));
      renderCalendar('/calendar?view=week&date=2026-11-02', {
        appointments: [makeAppointment({ id: 'later', startsAt: '2026-11-04T20:00:00.000Z', endsAt: '2026-11-04T21:00:00.000Z' })],
      });
      await screen.findByTestId('appt-later');
      await waitFor(() => expect(scroll.latest()).toBe(3 * 32));
    } finally {
      vi.useRealTimers();
      scroll.restore();
    }
  });
});

describe('where the grid starts on a phone', () => {
  const NOON_NOV_1 = new Date('2026-11-01T18:00:00.000Z');

  /** Runs a body with the clock fixed (the grid reads the day's clock), and puts the real one back. */
  async function atClock(clock: Date, body: () => Promise<void>) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  }

  const gridOf = async () => (await screen.findByTestId('time-grid')).firstElementChild as HTMLElement;

  it('pulls the hours up so the first visit is the first thing under the controls, and says which hours it left out', async () => {
    await atClock(NOON_NOV_1, async () => {
      // 9:00 AM Chicago is row 6; the grid starts a row above it (7:30 would be row 3: the first visit is 9:00)
      renderCalendar(
        '/calendar?date=2026-11-04',
        { appointments: [makeAppointment({ id: 'a1', startsAt: '2026-11-04T15:00:00.000Z', endsAt: '2026-11-04T16:00:00.000Z' })] },
        { phone: true },
      );
      await screen.findByTestId('appt-a1');
      const grid = await gridOf();
      expect(grid).toHaveAttribute('data-lead-rows', '5');
      // The rows before 8:30 AM are not drawn: the first slot is 8:30, the visit sits a row below it, and it still says it is row 6
      expect(screen.queryByTestId('slot-2026-11-04-08:00')).toBeNull();
      expect(screen.getByTestId('slot-2026-11-04-08:30')).toBeInTheDocument();
      const visit = screen.getByTestId('appt-a1');
      expect(visit).toHaveAttribute('data-row-start', '6');
      expect(visit.style.top).toBe('calc(1 * var(--row-h))');
      // The hours before are named on the row above the grid: 6:00 AM, to the start of the grid at 8:30 AM
      expect(screen.getByRole('button', { name: calendar.earlierHours('6:00 AM', '8:30 AM') })).toBeInTheDocument();
    });
  });

  it('brings the hours back on a tap, and the row goes', async () => {
    await atClock(NOON_NOV_1, async () => {
      const { user } = renderCalendar(
        '/calendar?date=2026-11-04',
        { appointments: [makeAppointment({ id: 'a1', startsAt: '2026-11-04T15:00:00.000Z', endsAt: '2026-11-04T16:00:00.000Z' })] },
        { phone: true },
      );
      await screen.findByTestId('appt-a1');
      await user.click(screen.getByTestId('earlier-hours'));
      expect(await gridOf()).not.toHaveAttribute('data-lead-rows');
      expect(screen.queryByTestId('earlier-hours')).toBeNull();
      // The first row of the window is on the grid again, and the visit is back at its own row
      expect(screen.getByTestId('slot-2026-11-04-06:00')).toBeInTheDocument();
      expect(screen.getByTestId('appt-a1').style.top).toBe('calc(6 * var(--row-h))');
    });
  });

  it('follows the days shown: another day with an earlier visit starts the grid earlier, so nothing hides above it', async () => {
    await atClock(NOON_NOV_1, async () => {
      const { user } = renderCalendar(
        '/calendar?date=2026-11-04',
        {
          appointments: [
            makeAppointment({ id: 'late', startsAt: '2026-11-04T18:00:00.000Z', endsAt: '2026-11-04T19:00:00.000Z' }),
            makeAppointment({ id: 'early', startsAt: '2026-11-05T13:00:00.000Z', endsAt: '2026-11-05T14:00:00.000Z' }),
          ],
        },
        { phone: true },
      );
      // Wednesday's only visit is at noon (row 12): the grid starts a row above it
      await screen.findByTestId('appt-late');
      expect(await gridOf()).toHaveAttribute('data-lead-rows', '11');
      // Thursday's first visit is at 7:00 AM (row 2): a tap on Thursday moves the start up with it, so that visit is not above the grid
      await user.click(screen.getByRole('button', { name: 'Thu, Nov 5' }));
      await screen.findByTestId('appt-early');
      expect(await gridOf()).toHaveAttribute('data-lead-rows', '1');
      expect(screen.getByRole('button', { name: calendar.earlierHours('6:00 AM', '6:30 AM') })).toBeInTheDocument();
    });
  });

  it('draws the part of a busy block that is in view and leaves out one that ended above the start', async () => {
    await atClock(NOON_NOV_1, async () => {
      // The first visit is 10:00 AM (row 8): the grid starts at 9:30 (row 7). Busy 7:00-9:00 is above it; busy 9:00-11:00 runs into it
      renderCalendar(
        '/calendar?date=2026-11-04',
        {
          appointments: [makeAppointment({ id: 'a1', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z' })],
          busy: [
            { userId: 'u2', start: '2026-11-04T13:00:00.000Z', end: '2026-11-04T15:00:00.000Z', allDay: false },
            { userId: 'u2', start: '2026-11-04T15:00:00.000Z', end: '2026-11-04T17:00:00.000Z', allDay: false },
          ],
        },
        { phone: true },
      );
      await screen.findByTestId('appt-a1');
      expect(await gridOf()).toHaveAttribute('data-lead-rows', '7');
      expect(screen.queryByTestId('busy-0')).toBeNull();
      const running = screen.getByTestId('busy-1');
      // Its own rows are 6 to 9; the part in view starts at the grid's first row and is three rows tall
      expect(running).toHaveAttribute('data-row-start', '6');
      expect(running.style.top).toBe('calc(0 * var(--row-h))');
      expect(running.style.height).toBe('calc(3 * var(--row-h) - 2px)');
    });
  });

  it('leaves the whole window when the day has no visit and is not today', async () => {
    await atClock(NOON_NOV_1, async () => {
      renderCalendar('/calendar?date=2026-11-04', {}, { phone: true });
      const grid = await gridOf();
      expect(grid).not.toHaveAttribute('data-lead-rows');
      expect(screen.queryByTestId('earlier-hours')).toBeNull();
    });
  });

  it('starts a few rows above the clock on today when there is no visit', async () => {
    // Sunday Nov 1 2:00 PM CST is 20:00Z; the clock's row is (840 - 360) / 30 = 16, so the grid starts three rows above it
    await atClock(new Date('2026-11-01T20:00:00.000Z'), async () => {
      renderCalendar('/calendar?date=2026-11-01', {}, { phone: true });
      expect(await gridOf()).toHaveAttribute('data-lead-rows', '13');
    });
  });

  it('is the same grid on a desktop, which scrolls inside its panel: nothing is pulled up and there is no row for earlier hours', async () => {
    await atClock(NOON_NOV_1, async () => {
      renderCalendar('/calendar?view=week&date=2026-11-02', {
        appointments: [makeAppointment({ id: 'a1', startsAt: '2026-11-04T15:00:00.000Z', endsAt: '2026-11-04T16:00:00.000Z' })],
      });
      await screen.findByTestId('appt-a1');
      expect(await gridOf()).not.toHaveAttribute('data-lead-rows');
      expect(screen.queryByTestId('earlier-hours')).toBeNull();
    });
  });
});
