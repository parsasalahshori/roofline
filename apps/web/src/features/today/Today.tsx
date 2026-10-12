import { type ReactNode, useId } from 'react';
import { Button, Card, EmptyState, Skeleton, UiLink } from '@roofline/ui';
import { useApprovals, useMe } from '../../api/hooks.ts';
import type { TaskView } from '../../api/types.ts';
import { errors } from '../../copy/errors.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { today } from '../../copy/today.ts';
import { countedDrafts } from '../../shell/countedDrafts.ts';
import { formatTime, zonedDateKey } from '../calendar/time.ts';
import { useCompany } from '../settings/api.ts';
import { useToday } from './api.ts';
import styles from './Today.module.css';

/** How many drafts the window lists before pointing at the full list. */
const SHOWN_DRAFTS = 3;

/** Morning before noon, afternoon before five, evening after, all in the company's time zone (the browser's until it loads). */
export function partOfDay(now: Date, timeZone: string | undefined): 'morning' | 'afternoon' | 'evening' {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

/** The plans waiting for a yes, newest first. The copy is sorted here so a new plan always leads. */
function newestFirst(tasks: TaskView[]): TaskView[] {
  return [...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** My day: a greeting, today's date, the plans waiting for a yes, and today's appointments. */
export function Today() {
  // Read per render, not at module load, so the clock is always the current one
  const now = new Date();
  const me = useMe();
  const approvalsQuery = useApprovals();
  const company = useCompany();
  const timeZone = company.data?.timezone;

  const [first = ''] = (me.data?.user.name ?? '').trim().split(/\s+/);
  const part = partOfDay(now, timeZone);
  const dateLine = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(now);

  const okId = useId();
  const appointmentsId = useId();
  const followUpsId = useId();
  const todayQuery = useToday();
  const zone = timeZone ?? 'America/Chicago';
  const seesEveryone = me.data?.role === 'owner' || me.data?.role === 'office';

  const drafts = newestFirst(countedDrafts(approvalsQuery.data));
  const shown = drafts.slice(0, SHOWN_DRAFTS);

  let okContent: ReactNode;
  if (approvalsQuery.data === undefined) {
    // While the plans load, a skeleton: "Nothing needs your OK" must not flash first
    okContent = approvalsQuery.isPending ? <Skeleton lines={2} /> : <p className={styles.note}>{errors.generic}</p>;
  } else if (drafts.length === 0) {
    okContent = <p className={styles.note}>{today.nothingNeedsYou}</p>;
  } else {
    okContent = (
      <>
        <ul aria-label={today.draftsLabel} className={styles.list}>
          {shown.map((task) => (
            <li key={task.id}>
              <UiLink href={'/approvals/' + encodeURIComponent(task.id)} className={styles.link}>
                <Card className={styles.card}>
                  <span className={styles.agent}>{AGENT_LABEL[task.agent]}</span>
                  <strong className={styles.title}>{task.title}</strong>
                </Card>
              </UiLink>
            </li>
          ))}
        </ul>
        {drafts.length > SHOWN_DRAFTS ? (
          <div className={styles.seeAll}>
            <Button variant="ghost" href="/approvals">
              {today.seeAll(drafts.length)}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  const seeEveryone = seesEveryone ? (
    <div className={styles.seeAll}>
      <Button variant="ghost" href={'/calendar?view=day&date=' + zonedDateKey(now, zone)}>
        {today.seeEveryone}
      </Button>
    </div>
  ) : null;

  let appointmentsContent: ReactNode;
  const view = todayQuery.data;
  if (view === undefined) {
    appointmentsContent = todayQuery.isPending ? <Skeleton lines={2} /> : <p className={styles.note}>{errors.generic}</p>;
  } else if (view.appointments.length === 0) {
    appointmentsContent = (
      <>
        <EmptyState title={today.noAppointments} />
        {seeEveryone}
      </>
    );
  } else {
    appointmentsContent = (
      <>
        <ul aria-label={today.appointmentsLabel} className={styles.list}>
          {view.appointments.map((a) => (
            <li key={a.id}>
              <UiLink href={'/calendar/appointments/' + encodeURIComponent(a.id)} className={styles.link}>
                <Card className={styles.card}>
                  <span className={styles.agent}>{a.allDay ? today.allDay : formatTime(new Date(a.startsAt), zone)}</span>
                  <span className={styles.agent}>{today.kindLabel[a.kind]}</span>
                  <strong className={styles.title}>{a.customerName ?? a.title}</strong>
                  <span className={styles.agent}>{a.addressLine ?? ''}</span>
                </Card>
              </UiLink>
            </li>
          ))}
        </ul>
        {seeEveryone}
      </>
    );
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h2 className={styles.heading}>{today.greeting(part, first)}</h2>
        <p className={styles.date}>{dateLine}</p>
      </header>

      <section aria-labelledby={okId} className={styles.section}>
        <h3 id={okId} className={styles.sectionTitle}>
          {today.needYourOk}
        </h3>
        {okContent}
      </section>

      <section aria-labelledby={appointmentsId} className={styles.section}>
        <h3 id={appointmentsId} className={styles.sectionTitle}>
          {today.appointments}
        </h3>
        {appointmentsContent}
      </section>

      {view !== undefined && view.followUps.length > 0 ? (
        <section aria-labelledby={followUpsId} className={styles.section}>
          <h3 id={followUpsId} className={styles.sectionTitle}>
            {today.followUps}
          </h3>
          <ul aria-label={today.followUpsLabel} className={styles.list}>
            {view.followUps.map((job) => (
              <li key={job.id}>
                <UiLink href={'/jobs/' + encodeURIComponent(job.id)} className={styles.link}>
                  <Card className={styles.card}>
                    {job.frontDesk === 'urgent' || job.frontDesk === 'message' ? (
                      <span className={styles.fromFrontDesk}>
                        {job.frontDesk === 'urgent' ? today.fromFrontDeskUrgent : today.fromFrontDesk}
                      </span>
                    ) : null}
                    <strong className={styles.title}>{job.customerName}</strong>
                    <span className={styles.agent}>{today.nextStep(job.nextStep)}</span>
                  </Card>
                </UiLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
