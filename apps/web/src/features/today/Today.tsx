import { Button, Icon, IconButton, Skeleton, Tag, UiLink } from '@roofline/ui';
import { type ReactNode, useId } from 'react';
import { useApprovals, useMe } from '../../api/hooks.ts';
import { errors } from '../../copy/errors.ts';
import { home } from '../../copy/home.ts';
import { proposals } from '../../copy/proposals.ts';
import { today } from '../../copy/today.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { countedDrafts } from '../../shell/countedDrafts.ts';
import { directionsUrl, NEW_TAB } from '../../shell/map/directions.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { zonedDateKey } from '../calendar/time.ts';
import { useBoard } from '../jobs/api.ts';
import { useCompany } from '../settings/api.ts';
import { useSignedToday, useToday } from './api.ts';
import { HomeApproval } from './HomeApproval.tsx';
import { newestFirst } from './homeFacts.ts';
import { PipelineTile, SignedTile } from './HomeKpis.tsx';
import styles from './Today.module.css';
import { useNow } from './useNow.ts';
import { KIND_COLOR, liveVisits, visitTime } from './visits.ts';

/** How many ghost rows an empty list draws. */
const GHOST_ROWS = 3;

/** One section's head: the title, a quiet count beside it, and a link at the far end. */
function SectionHead({ id, title, meta, action }: { id: string; title: string; meta?: string | undefined; action?: ReactNode }) {
  return (
    <header className={styles.head}>
      <h2 id={id} className={styles.title}>
        {title}
      </h2>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
      {action ? <span className={styles.action}>{action}</span> : null}
    </header>
  );
}

/**
 * The newest plan waiting for a yes, as an approval card, with a line under it for the rest. One decision on top and then
 * the day: the full queue is the Need your OK page. Only the owner and office decide on plans, so a rep never gets this section.
 */
function ApprovalsSection() {
  const id = useId();
  const query = useApprovals();
  const drafts = newestFirst(countedDrafts(query.data));
  const [newest] = drafts;

  let body: ReactNode;
  if (query.data === undefined) {
    // While the plans load, a skeleton: "Nothing needs your OK" must not flash first
    body = query.isPending ? <Skeleton lines={3} height="3rem" /> : <p className={styles.note}>{errors.generic}</p>;
  } else if (newest === undefined) {
    body = (
      <p className={styles.quiet}>
        <Icon name="check" size={16} />
        {today.nothingNeedsYou}
      </p>
    );
  } else {
    body = <HomeApproval key={newest.id} task={newest} more={drafts.length - 1} />;
  }

  return (
    <section aria-labelledby={id} className={styles.section}>
      <SectionHead id={id} title={today.needYourOk} />
      {body}
    </section>
  );
}

/** Today's visits, earliest first: the time and kind, who and where, and a button for directions. The one under way or coming next is marked. */
function VisitsSection({ zone, seesEveryone }: { zone: string; seesEveryone: boolean }) {
  const id = useId();
  const query = useToday();
  const board = useBoard({});
  const now = useNow();
  const leads = board.data?.columns.find((column) => column.stage === 'lead')?.count ?? 0;

  const view = query.data;
  const visits = view ? liveVisits(view.appointments) : undefined;
  // The next visit: the first one still to come (or on now) that is not done
  const nextVisit = visits?.find((visit) => !visit.allDay && visit.status === 'scheduled' && Date.parse(visit.endsAt) > now);
  const nextId = nextVisit?.id;
  // Already started by the clock: it reads "Now", not "Next"
  const underway = nextVisit !== undefined && Date.parse(nextVisit.startsAt) <= now;

  let body: ReactNode;
  if (visits === undefined) {
    body = query.isPending ? (
      <Skeleton lines={3} height="3.5rem" />
    ) : (
      <p className={styles.note}>{errors.generic}</p>
    );
  } else if (visits.length === 0) {
    body = (
      <div className={styles.card}>
        <ul className={styles.ghosts} aria-hidden="true">
          {Array.from({ length: GHOST_ROWS }, (_, i) => (
            <li key={i} className={styles.ghost}>
              <span className={styles.ghostTime} />
              <span className={styles.ghostText}>
                <span />
                <span />
              </span>
            </li>
          ))}
        </ul>
        <div className={styles.emptyText}>
          <p className={styles.emptyTitle}>{today.noAppointments}</p>
          <p className={styles.emptyHelp}>{leads > 0 ? home.noVisitsLeads(leads) : today.noAppointmentsHelp}</p>
          <Button variant="default" href="/calendar/new">
            {today.bookVisit}
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <ul aria-label={today.appointmentsLabel} className={`${styles.card} ${styles.visits}`}>
        {visits.map((visit) => {
          const clock = visit.allDay ? null : visitTime(visit.startsAt, zone);
          const who = visit.customerName ?? visit.title;
          const detail = [visit.addressLine, visit.source === 'front_desk' ? home.fromFrontDesk : null].filter(
            (part): part is string => part !== null && part !== '',
          );
          const isNext = visit.id === nextId;
          const isDone = visit.status === 'completed';
          return (
            <li key={visit.id} className={styles.visit} data-next={isNext ? 'true' : undefined} data-done={isDone ? 'true' : undefined}>
              <span className={styles.edge} style={{ background: KIND_COLOR[visit.kind] }} aria-hidden="true" />
              <UiLink href={'/calendar/appointments/' + encodeURIComponent(visit.id)} className={styles.visitLink}>
                <span className={styles.when}>
                  {clock === null ? (
                    <span className={styles.allDay}>{today.allDay}</span>
                  ) : (
                    <span className={styles.clock}>
                      {clock.clock}
                      <small>{clock.meridiem}</small>
                    </span>
                  )}
                  <span className={styles.kind}>{today.kindLabel[visit.kind]}</span>
                </span>
                <span className={styles.who}>
                  <b>{who}</b>
                  {detail.length > 0 ? <small>{today.detail(detail)}</small> : null}
                </span>
              </UiLink>
              <span className={styles.end}>
                {isDone ? (
                  <Tag tone="ok" icon="check">
                    {today.done}
                  </Tag>
                ) : isNext ? (
                  <Tag tone="brand" icon="clock">
                    {underway ? today.now : today.next}
                  </Tag>
                ) : null}
                {visit.addressLine !== null && visit.addressLine !== '' ? (
                  <IconButton
                    label={today.directionsTo(who)}
                    href={directionsUrl(visit.addressLine)}
                    {...NEW_TAB}
                    className={styles.directions}
                    data-primary={isNext ? 'true' : undefined}
                    icon={<Icon name="route" size={18} />}
                  />
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section aria-labelledby={id} className={styles.section}>
      <SectionHead
        id={id}
        title={today.appointments}
        meta={visits === undefined ? undefined : today.visitsCount(visits.length)}
        action={
          <Button size="sm" variant="ghost" href={seesEveryone ? '/calendar?view=day&date=' + zonedDateKey(new Date(), zone) : '/calendar'}>
            {seesEveryone ? today.seeEveryone : home.calendar}
            <Icon name="chev" size={16} />
          </Button>
        }
      />
      {body}
    </section>
  );
}

/** The jobs whose next step falls today, with a flag on the ones the Front Desk raised. Left out when there are none. */
function FollowUpsSection() {
  const id = useId();
  const query = useToday();
  const jobs = query.data?.followUps ?? [];
  if (jobs.length === 0) return null;
  return (
    <section aria-labelledby={id} className={styles.section}>
      <SectionHead id={id} title={today.followUps} />
      <ul aria-label={today.followUpsLabel} className={`${styles.card} ${styles.rows}`}>
        {jobs.map((job) => (
          <li key={job.id}>
            <UiLink href={'/jobs/' + encodeURIComponent(job.id)} className={styles.row}>
              <span className={styles.who}>
                <b>{job.customerName}</b>
                <small>{today.nextStep(job.nextStep)}</small>
              </span>
              {job.frontDesk === 'urgent' ? (
                <Tag tone="bad" icon="alert">
                  {today.fromFrontDeskUrgent}
                </Tag>
              ) : job.frontDesk === 'message' ? (
                <Tag tone="info" icon="phone">
                  {today.fromFrontDesk}
                </Tag>
              ) : null}
            </UiLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Proposals signed today (the company's calendar day), with what each customer chose. */
function SignedTodaySection({ dateKey }: { dateKey: string }) {
  const id = useId();
  const query = useSignedToday(dateKey);
  if (query.data === undefined) return null;
  return (
    <section aria-labelledby={id} className={styles.section}>
      <SectionHead id={id} title={today.signedToday} />
      {query.data.proposals.length === 0 ? (
        <p className={styles.quiet}>{today.signedNone}</p>
      ) : (
        <ul aria-label={today.signedLabel} className={`${styles.card} ${styles.rows}`}>
          {query.data.proposals.map((p) => {
            const option = p.options.find((o) => o.id === p.signed?.optionId);
            return (
              <li key={p.id}>
                <UiLink href={'/estimator/proposals/' + encodeURIComponent(p.id)} className={styles.row}>
                  <span className={styles.who}>
                    <b>{p.customer.name}</b>
                    <small>{p.address}</small>
                  </span>
                  {option !== undefined ? (
                    <span className={styles.money}>
                      {p.basis === 'exact' ? proposals.money(option.totalCents) : today.signedEstimate(proposals.money(option.totalCents))}
                    </span>
                  ) : null}
                </UiLink>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * My day: the plans waiting for a yes, today's visits (the next one marked, each with directions), the jobs to
 * follow up, this month's numbers and what was signed today. The page head (the date over "My day") is the page's own.
 */
export function Today() {
  const me = useMe();
  const company = useCompany();
  const phone = useIsPhone();
  const zone = company.data?.timezone ?? 'America/Chicago';
  const seesEveryone = me.data?.role === 'owner' || me.data?.role === 'office';
  const monthId = useId();

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        {seesEveryone ? <ApprovalsSection /> : null}
        <VisitsSection zone={zone} seesEveryone={seesEveryone} />
        <FollowUpsSection />
      </div>
      <div className={styles.side}>
        <section aria-labelledby={monthId} className={styles.section}>
          <SectionHead id={monthId} title={today.thisMonth} />
          <div className={styles.tiles}>
            <SignedTile bars={!phone} label={today.signed} />
            <PipelineTile />
          </div>
        </section>
        <SignedTodaySection dateKey={zonedDateKey(new Date(), zone)} />
      </div>
    </div>
  );
}

/** The page at /today: the date over the title (a phone leaves out the line under it), then My day. */
export function TodayPage() {
  const company = useCompany();
  const phone = useIsPhone();
  const dateLine = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: phone ? 'short' : 'long',
    day: 'numeric',
    timeZone: company.data?.timezone,
  }).format(new Date());
  return (
    <AppPage app="today" eyebrow={dateLine} subtitle={phone ? false : undefined}>
      <Today />
    </AppPage>
  );
}
