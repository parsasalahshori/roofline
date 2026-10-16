import { Avatar, Button, Icon, Panel, Skeleton, UiLink } from '@roofline/ui';
import { useMemo } from 'react';
import { errors } from '../../copy/errors.ts';
import { home } from '../../copy/home.ts';
import { today } from '../../copy/today.ts';
import { addZonedDays, dateKeyToInstant, zonedDateKey } from '../calendar/time.ts';
import { useAppointments } from '../calendar/api.ts';
import { useBoard } from '../jobs/api.ts';
import { useCompany } from '../settings/api.ts';
import styles from './HomeToday.module.css';
import { KIND_COLOR, liveVisits, visitTime } from './visits.ts';

/** How many ghost rows the empty panel draws: the shape of a day, so the panel does not collapse to a sentence. */
const GHOST_ROWS = 3;

/**
 * Today's visits as the Home panel: the time, a bar in the kind's colour, who and where, and the person going. The
 * owner and office see everyone's day; a rep sees their own (the server decides who sees what). With no visits it
 * says so, shows what a day looks like, and offers to book one.
 */
export function HomeToday() {
  const company = useCompany();
  const zone = company.data?.timezone ?? 'America/Chicago';
  const todayKey = zonedDateKey(new Date(), zone);
  // The day's edges are worked out once a day, so the query key does not change with every render
  const range = useMemo(() => {
    const from = dateKeyToInstant(todayKey, zone);
    return { from: from.toISOString(), to: addZonedDays(from, 1, zone).toISOString() };
  }, [todayKey, zone]);
  const query = useAppointments({ ...range, userIds: [], enabled: company.data !== undefined });
  const board = useBoard({});
  const leads = board.data?.columns.find((column) => column.stage === 'lead')?.count ?? 0;

  const visits = query.data ? liveVisits(query.data.appointments) : undefined;

  return (
    <Panel
      title={home.todayTitle}
      tag={visits === undefined ? undefined : home.visits(visits.length)}
      actions={
        <Button size="sm" variant="ghost" href="/calendar">
          {home.calendar}
          <Icon name="chev" size={16} />
        </Button>
      }
      padded={false}
      className={styles.panel}
    >
      {visits === undefined ? (
        query.isError ? (
          <div className={styles.note}>
            <p>{home.visitsFailed}</p>
            <Button size="sm" variant="default" onClick={() => void query.refetch()}>
              {errors.tryAgain}
            </Button>
          </div>
        ) : (
          <ul className={styles.list} aria-busy="true" aria-label={home.visitsLabel}>
            {Array.from({ length: GHOST_ROWS }, (_, i) => (
              <li key={i} className={styles.row} aria-hidden="true">
                <Skeleton width="3rem" height="14px" />
                <span className={styles.bar} data-ghost="true" />
                <span className={styles.text}>
                  <Skeleton width="70%" height="14px" />
                  <Skeleton width="50%" height="12px" />
                </span>
                <span />
              </li>
            ))}
          </ul>
        )
      ) : visits.length === 0 ? (
        <div className={styles.empty}>
          <ul className={styles.ghosts} aria-hidden="true">
            {Array.from({ length: GHOST_ROWS }, (_, i) => (
              <li key={i} className={styles.ghost}>
                <span className={styles.ghostTime} />
                <span className={styles.bar} data-ghost="true" />
                <span className={styles.ghostText}>
                  <span />
                  <span />
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.emptyText}>
            <p className={styles.emptyTitle}>{home.noVisits}</p>
            <p className={styles.emptyHelp}>{leads > 0 ? home.noVisitsLeads(leads) : home.noVisitsHelp}</p>
            <Button size="sm" variant="default" href="/calendar/new">
              {home.bookVisit}
            </Button>
          </div>
        </div>
      ) : (
        <ul className={styles.list} aria-label={home.visitsLabel}>
          {visits.map((visit) => {
            const time = visit.allDay ? null : visitTime(visit.startsAt, zone);
            const who = visit.customerName ?? visit.title;
            const detail = [visit.addressLine, visit.source === 'front_desk' ? home.fromFrontDesk : null].filter((part): part is string => part !== null && part !== '');
            return (
              <li key={visit.id}>
                <UiLink href={'/calendar/appointments/' + encodeURIComponent(visit.id)} className={styles.row}>
                  <span className={styles.time}>
                    {time === null ? (
                      <span className={styles.allDay}>{home.allDay}</span>
                    ) : (
                      <>
                        {time.clock}
                        <small className={styles.meridiem}>{time.meridiem}</small>
                      </>
                    )}
                  </span>
                  <span className={styles.bar} style={{ background: KIND_COLOR[visit.kind] }} aria-hidden="true" />
                  <span className={styles.text}>
                    <b>{home.visitTitle(today.kindLabel[visit.kind], who)}</b>
                    {detail.length > 0 ? <small>{home.visitDetail(detail)}</small> : null}
                  </span>
                  {visit.assigned ? (
                    <span className={styles.who} title={visit.assigned.name}>
                      <Avatar name={visit.assigned.name} size={28} />
                      <span className="visually-hidden">{visit.assigned.name}</span>
                    </span>
                  ) : (
                    <span />
                  )}
                </UiLink>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
