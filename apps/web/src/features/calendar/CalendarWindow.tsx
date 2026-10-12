import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, Skeleton } from '@roofline/ui';
import { apiFetch } from '../../api/client.ts';
import type { TeamBody } from '../../api/types.ts';
import { useMe } from '../../api/hooks.ts';
import { calendar } from '../../copy/calendar.ts';
import { useCompany } from '../settings/api.ts';
import { AgendaView } from './AgendaView.tsx';
import { useAppointments, useSyncNow } from './api.ts';
import { CalendarToolbar } from './CalendarToolbar.tsx';
import { DayView } from './DayView.tsx';
import { colorFor } from './PeoplePicker.tsx';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import {
  addZonedDays,
  browserZone,
  dateKeyToInstant,
  formatDayLabel,
  formatRangeLabel,
  startOfZonedDay,
  weekStart,
  zoneName,
  zonedDateKey,
} from './time.ts';
import type { AppointmentsBody, CalendarPerson, CalendarView } from './types.ts';
import { WeekView } from './WeekView.tsx';
import styles from './CalendarWindow.module.css';

const DEFAULT_ZONE = 'America/Chicago';
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const VIEWS: readonly CalendarView[] = ['week', 'day', 'list'];
/** How far the list view moves per page, and how far prev/next move in each view. */
const LIST_PAGE_DAYS = 14;
const STEP_DAYS: Record<CalendarView, number> = { week: 7, day: 1, list: LIST_PAGE_DAYS };
const CLOCK_MS = 60_000;
const NO_APPOINTMENTS: AppointmentsBody = { appointments: [], busy: [] };

/** The team, for the people picker and the colours. A local query: its key is the calendar's own. */
function useCalendarTeam() {
  return useQuery({
    queryKey: ['calendar', 'team'] as const,
    queryFn: ({ signal }) => apiFetch<TeamBody>('/api/team', { signal }),
  });
}

/** The Calendar window: week, day or list of appointments for the people chosen, in the company time zone. */
export function CalendarWindow() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const company = useCompany();
  const me = useMe();
  const team = useCalendarTeam();
  const isPhone = useIsPhone();
  const [showCanceled, setShowCanceled] = useState(false);
  const [pages, setPages] = useState(1);
  const [now, setNow] = useState(() => new Date());

  useSyncNow();

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const zone = company.data?.timezone ?? DEFAULT_ZONE;
  const role = me.data?.role;
  const isRep = role === 'rep';
  const members = (team.data?.members ?? []).filter((member) => member.status === 'active');
  const people: CalendarPerson[] = members.map((member, index) => ({
    userId: member.userId,
    name: member.name,
    color: colorFor(index),
  }));

  // The people in the request. A rep sees only themselves; everyone else sees the team unless the URL says otherwise.
  const peopleParam = params.get('people');
  let userIds: string[];
  if (isRep) {
    userIds = me.data ? [me.data.user.id] : [];
  } else if (peopleParam !== null) {
    userIds = peopleParam.split(',').filter((id) => id !== '');
  } else {
    userIds = people.map((person) => person.userId);
  }

  const viewParam = params.get('view');
  const view: CalendarView = VIEWS.find((candidate) => candidate === viewParam) ?? (isPhone ? 'list' : 'week');
  const dateParam = params.get('date');
  const dateKey = dateParam !== null && DATE_KEY.test(dateParam) ? dateParam : zonedDateKey(now, zone);
  const dateInstant = dateKeyToInstant(dateKey, zone);

  // The range fetched: the week, the day, or the list's pages of days.
  let from: Date;
  let to: Date;
  let days: Date[] = [];
  if (view === 'week') {
    from = weekStart(dateInstant, zone);
    days = Array.from({ length: 7 }, (_, offset) => addZonedDays(from, offset, zone));
    to = addZonedDays(from, 7, zone);
  } else if (view === 'day') {
    from = startOfZonedDay(dateInstant, zone);
    days = [from];
    to = addZonedDays(from, 1, zone);
  } else {
    from = startOfZonedDay(dateInstant, zone);
    to = addZonedDays(from, LIST_PAGE_DAYS * pages, zone);
  }
  const dayCount = LIST_PAGE_DAYS * pages;

  // With every person unticked there is nobody to ask for: the query stays off and the answer is empty.
  const noOne = !isRep && peopleParam !== null && userIds.length === 0;
  const appointments = useAppointments({ from: from.toISOString(), to: to.toISOString(), userIds, enabled: !noOne });
  // keepPreviousData would otherwise show the last unfiltered answer while noOne holds.
  const data = noOne ? NO_APPOINTMENTS : appointments.data;

  const updateParams = (change: (next: URLSearchParams) => void) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      change(next);
      return next;
    });
  };

  const moveBy = (count: number) => {
    const moved = addZonedDays(dateInstant, count, zone);
    setPages(1);
    updateParams((next) => next.set('date', zonedDateKey(moved, zone)));
  };

  const changeView = (next: CalendarView) => {
    setPages(1);
    updateParams((search) => search.set('view', next));
  };

  const changePeople = (ids: string[]) => {
    updateParams((search) => search.set('people', ids.join(',')));
  };

  const goToday = () => {
    setPages(1);
    updateParams((search) => search.delete('date'));
  };

  const onSlot = (startIso: string) => {
    navigate(`/calendar/new?start=${encodeURIComponent(startIso)}&people=${userIds.join(',')}`);
  };

  const onOpen = (appointmentId: string) => {
    navigate(`/calendar/appointments/${appointmentId}`);
  };

  if (company.isPending || me.isPending || team.isPending) {
    return (
      <div className={styles.window}>
        <Skeleton height="48px" />
        <Skeleton height="320px" />
      </div>
    );
  }

  const label = view === 'day' ? formatDayLabel(dateInstant, zone) : formatRangeLabel(from, to, zone);

  const zoneNote = browserZone() !== zone ? calendar.zoneNote(zoneName(zone)) : null;

  let body;
  if (!noOne && appointments.isError) {
    body = <EmptyState title={calendar.loadError} />;
  } else if (data === undefined) {
    body = <Skeleton height="320px" />;
  } else {
    if (view === 'list') {
      body = (
        <AgendaView
          zone={zone}
          from={from}
          dayCount={dayCount}
          appointments={data.appointments}
          people={people}
          showCanceled={showCanceled}
          onOpen={onOpen}
          onLoadMore={() => setPages((count) => count + 1)}
        />
      );
    } else if (view === 'day') {
      body = (
        <DayView
          zone={zone}
          days={days}
          appointments={data.appointments}
          busy={data.busy}
          people={people}
          showCanceled={showCanceled}
          now={now}
          onSlot={onSlot}
          onOpen={onOpen}
        />
      );
    } else {
      body = (
        <WeekView
          zone={zone}
          days={days}
          appointments={data.appointments}
          busy={data.busy}
          people={people}
          showCanceled={showCanceled}
          now={now}
          onSlot={onSlot}
          onOpen={onOpen}
        />
      );
    }
  }

  return (
    <div className={styles.window}>
      <CalendarToolbar
        view={view}
        label={label}
        onView={changeView}
        onToday={goToday}
        onPrev={() => moveBy(-STEP_DAYS[view])}
        onNext={() => moveBy(STEP_DAYS[view])}
        onNew={() => navigate('/calendar/new')}
        people={people}
        selected={userIds}
        onPeople={changePeople}
        showPeople={!isRep}
        showCanceled={showCanceled}
        onShowCanceled={setShowCanceled}
        zoneNote={zoneNote}
      />
      <div className={styles.body}>{body}</div>
    </div>
  );
}
