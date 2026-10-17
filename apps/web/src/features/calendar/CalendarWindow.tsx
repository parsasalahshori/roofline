import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Banner, Button, Icon, Panel, Skeleton } from '@roofline/ui';
import { apiFetch } from '../../api/client.ts';
import type { TeamBody } from '../../api/types.ts';
import { useMe } from '../../api/hooks.ts';
import { calendar } from '../../copy/calendar.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { useCompany } from '../settings/api.ts';
import { AgendaView } from './AgendaView.tsx';
import { useAppointments, useSyncNow } from './api.ts';
import { colorFor } from './colors.ts';
import { CalendarToolbar } from './CalendarToolbar.tsx';
import { DayStrip } from './DayStrip.tsx';
import { TimeGrid } from './TimeGrid.tsx';
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
import styles from './CalendarWindow.module.css';

const DEFAULT_ZONE = 'America/Chicago';
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const VIEWS: readonly CalendarView[] = ['week', 'day', 'list'];
/** How far the list view moves per page, and how far prev/next move in each view. */
const LIST_PAGE_DAYS = 14;
const STEP_DAYS: Record<CalendarView, number> = { week: 7, day: 1, list: LIST_PAGE_DAYS };
const CLOCK_MS = 60_000;
const NO_APPOINTMENTS: AppointmentsBody = { appointments: [], busy: [] };

/** The team, for the people chips and the colours. A local query: its key is the calendar's own. */
function useCalendarTeam() {
  return useQuery({
    queryKey: ['calendar', 'team'] as const,
    queryFn: ({ signal }) => apiFetch<TeamBody>('/api/team', { signal }),
  });
}

/** The shape of the grid that is on its way: the days across the head, hairlines down the page and a few visits. */
function GridSkeleton() {
  return (
    <Panel as="section" padded={false} className={styles.gridPanel} aria-busy="true">
      <div className={styles.skeleton} role="status" aria-label={calendar.gridLabel}>
        <div className={styles.skeletonHead}>
          {[0, 1, 2, 3, 4, 5, 6].map((day) => (
            <Skeleton key={day} width="55%" height="16px" />
          ))}
        </div>
        <div className={styles.skeletonBody}>
          <span className={styles.skeletonBlock} data-at="a" />
          <span className={styles.skeletonBlock} data-at="b" />
          <span className={styles.skeletonBlock} data-at="c" />
          <span className={styles.skeletonBlock} data-at="d" />
        </div>
      </div>
    </Panel>
  );
}

/**
 * The Calendar page: Day, Week or List of appointments for the people chosen, in the company time zone. The page head has the
 * one primary button; the controls sit under it; the week and the day are a time grid on its own panel, the list a table
 * for each day. A phone opens on the day, with the days of its week in a strip.
 */
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
  const view: CalendarView = VIEWS.find((candidate) => candidate === viewParam) ?? (isPhone ? 'day' : 'week');
  const dateParam = params.get('date');
  const todayKey = zonedDateKey(now, zone);
  const dateKey = dateParam !== null && DATE_KEY.test(dateParam) ? dateParam : todayKey;
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

  // Nothing is asked until the zone, the person and the team are known: before then the people are not, and a read without
  // people means everyone. With every person unticked there is nobody to ask for: the query stays off and the answer is empty.
  const loading = company.isPending || me.isPending || team.isPending;
  const noOne = !isRep && peopleParam !== null && userIds.length === 0;
  const appointments = useAppointments({ from: from.toISOString(), to: to.toISOString(), userIds, includeCanceled: showCanceled, enabled: !noOne && !loading });
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

  const pickDay = (key: string) => {
    updateParams((search) => search.set('date', key));
  };

  const onSlot = (startIso: string) => {
    navigate(`/calendar/new?start=${encodeURIComponent(startIso)}&people=${userIds.join(',')}`);
  };

  const onOpen = (appointmentId: string) => {
    navigate(`/calendar/appointments/${appointmentId}`);
  };

  const newButton = (
    <Button variant="primary" href="/calendar/new">
      <Icon name="plus" size={16} />
      {calendar.newAppointment}
    </Button>
  );

  if (loading) {
    return (
      <AppPage
        app="calendar"
        layout="flow"
        actions={newButton}
        tabs={
          <div className={styles.controls}>
            <Skeleton height="36px" width="60%" />
            <Skeleton height="28px" width="40%" />
          </div>
        }
      >
        <GridSkeleton />
      </AppPage>
    );
  }

  const label = view === 'day' ? formatDayLabel(dateInstant, zone) : formatRangeLabel(from, to, zone);
  const zoneNote = browserZone() !== zone ? calendar.zoneNote(zoneName(zone)) : null;

  let body;
  if (!noOne && appointments.isError) {
    body = (
      <Banner
        tone="danger"
        action={
          <Button variant="default" size="sm" onClick={() => void appointments.refetch()}>
            {calendar.tryAgain}
          </Button>
        }
      >
        {calendar.loadError}
      </Banner>
    );
  } else if (data === undefined) {
    body = <GridSkeleton />;
  } else if (view === 'list') {
    body = (
      <AgendaView
        zone={zone}
        from={from}
        dayCount={dayCount}
        appointments={data.appointments}
        people={people}
        showCanceled={showCanceled}
        todayKey={todayKey}
        onOpen={onOpen}
        onLoadMore={() => setPages((count) => count + 1)}
      />
    );
  } else {
    body = (
      <Panel as="section" padded={false} className={styles.gridPanel}>
        <TimeGrid
          zone={zone}
          days={days}
          appointments={data.appointments}
          busy={data.busy}
          people={people}
          showCanceled={showCanceled}
          now={now}
          pageScrolls={isPhone && view === 'day'}
          onSlot={onSlot}
          onOpen={onOpen}
        />
      </Panel>
    );
  }

  return (
    <AppPage
      app="calendar"
      layout={isPhone || view === 'list' ? 'flow' : 'fill'}
      actions={newButton}
      tabs={
        <div className={styles.controls}>
          <CalendarToolbar
            view={view}
            label={label}
            onView={changeView}
            onToday={goToday}
            onPrev={() => moveBy(-STEP_DAYS[view])}
            onNext={() => moveBy(STEP_DAYS[view])}
            people={people}
            selected={userIds}
            onPeople={changePeople}
            showPeople={!isRep}
            showCanceled={showCanceled}
            onShowCanceled={setShowCanceled}
            zoneNote={zoneNote}
          />
          {isPhone && view === 'day' ? <DayStrip zone={zone} date={dateInstant} todayKey={todayKey} onPick={pickDay} /> : null}
        </div>
      }
    >
      {body}
    </AppPage>
  );
}
