import { useId, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { isTimeZone, type AppointmentView, type JobView, type TaskStatus } from '@roofline/shared';
import { Button, EmptyState, UiLink, useToast } from '@roofline/ui';
import { job } from '../../copy/job.ts';
import { jobs } from '../../copy/jobs.ts';
import { TASK_STATUS_LABEL } from '../../copy/status.ts';
import { useCompany } from '../settings/api.ts';
import { formatDollars } from '../jobs/JobCardView.tsx';
import { Timeline } from '../timeline/Timeline.tsx';
import { useCreateQuote } from './api.ts';
import { ClaimSection } from './ClaimSection.tsx';
import styles from './JobSections.module.css';

export type JobSectionsProps = { view: JobView };

const FALLBACK_ZONE = 'America/Chicago';

/** The company's zone when it is one Intl knows, the Chicago default otherwise. Never the browser's. */
function useCompanyZone(): string {
  const company = useCompany();
  const zone = company.data?.timezone;
  return zone !== undefined && isTimeZone(zone) ? zone : FALLBACK_ZONE;
}

/** A plan's status word, or null for a status with no fixed words (`partly_done`). */
function taskWord(status: TaskStatus): string | null {
  return isFixedStatus(status) ? TASK_STATUS_LABEL[status] : null;
}

function isFixedStatus(status: TaskStatus): status is Exclude<TaskStatus, 'partly_done'> {
  return Object.hasOwn(TASK_STATUS_LABEL, status);
}

/** One titled block of the job: a section with its heading, labelled by it. */
function Section({ title, children, name }: { title: string; children: ReactNode; name: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.section} data-section={name}>
      <h2 id={headingId} className={styles.heading}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The four blocks under the header: appointments, quotes, agent tasks and the timeline. */
export function JobSections({ view }: JobSectionsProps) {
  const zone = useCompanyZone();
  const navigate = useNavigate();
  const toast = useToast();
  const createQuote = useCreateQuote(view.job.id);
  const jobId = view.job.id;

  const whenFormat = useMemo(
    () => new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }),
    [zone],
  );
  const dayFormat = useMemo(() => new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'medium' }), [zone]);

  function whenText(appointment: AppointmentView): string {
    const start = new Date(appointment.startsAt);
    return appointment.allDay ? job.appointmentAllDay(dayFormat.format(start)) : whenFormat.format(start);
  }

  async function startQuote() {
    try {
      const { id } = await createQuote.mutateAsync();
      navigate(`/jobs/${jobId}/quotes/${id}`);
    } catch {
      toast.show(job.quoteCreateFailed, 'error');
    }
  }

  return (
    <div className={styles.sections}>
      <Section title={job.appointmentsTitle} name="appointments">
        {view.can.edit ? (
          <div className={styles.actions}>
            <Button variant="ghost" href={`/calendar/new?jobId=${jobId}&kind=inspection`}>
              {job.bookInspection}
            </Button>
            <Button variant="ghost" href={`/calendar/new?jobId=${jobId}&kind=install`}>
              {job.bookInstall}
            </Button>
          </div>
        ) : null}
        {view.appointments.length === 0 ? (
          <EmptyState title={job.appointmentsEmpty} />
        ) : (
          <ul className={styles.list}>
            {view.appointments.map((appointment) => (
              <li
                key={appointment.id}
                className={styles.item}
                data-kind={appointment.kind}
                data-status={appointment.status}
              >
                {job.appointmentLine(
                  job.appointmentKind[appointment.kind],
                  whenText(appointment),
                  appointment.assigned?.name ?? jobs.unassigned,
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={job.quotesTitle} name="quotes">
        {view.can.edit ? (
          <div className={styles.actions}>
            <Button variant="primary" busy={createQuote.isPending} onClick={() => void startQuote()}>
              {job.newQuote}
            </Button>
          </div>
        ) : null}
        {view.quotes.length === 0 ? (
          <EmptyState title={job.quotesEmpty} />
        ) : (
          <ul className={styles.list}>
            {view.quotes.map((quote) => (
              <li key={quote.id}>
                <UiLink href={`/jobs/${jobId}/quotes/${quote.id}`} className={styles.link} data-status={quote.status}>
                  <span className={styles.strong}>{quote.number}</span>
                  <span className={styles.meta}>{job.quoteStatus[quote.status]}</span>
                  {view.can.seeValue ? (
                    <span className={styles.meta}>{job.quoteTotal(formatDollars(quote.totalCents))}</span>
                  ) : null}
                </UiLink>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ClaimSection jobId={jobId} />

      <Section title={job.tasksTitle} name="tasks">
        {view.tasks.length === 0 ? (
          <EmptyState title={job.tasksEmpty} />
        ) : (
          <ul className={styles.list}>
            {view.tasks.map((task) => {
              const word = taskWord(task.status);
              return (
                <li key={task.id}>
                  <UiLink href={`/approvals/${task.id}`} className={styles.link} data-status={task.status}>
                    <span className={styles.strong}>{task.title}</span>
                    {word !== null ? <span className={styles.meta}>{word}</span> : null}
                  </UiLink>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={job.timelineTitle} name="timeline">
        <Timeline jobId={jobId} />
      </Section>
    </div>
  );
}
