import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { AppointmentView, JobView, TaskStatus } from '@roofline/shared';
import { Button, Icon, Panel, Tag, UiLink, useToast } from '@roofline/ui';
import { appointments } from '../../copy/appointments.ts';
import { job } from '../../copy/job.ts';
import { jobs } from '../../copy/jobs.ts';
import { TASK_STATUS_LABEL } from '../../copy/status.ts';
import { formatDollars } from '../jobs/format.ts';
import { EmptyPanel } from '../jobs/states.tsx';
import { useCompanyZone } from '../jobs/useCompanyToday.ts';
import { useCreateQuote } from './api.ts';
import styles from './JobSections.module.css';

type PanelProps = { view: JobView; className?: string };

/** A plan's status word, or null for a status with no fixed words (`partly_done`). */
function taskWord(status: TaskStatus): string | null {
  return isFixedStatus(status) ? TASK_STATUS_LABEL[status] : null;
}

function isFixedStatus(status: TaskStatus): status is Exclude<TaskStatus, 'partly_done'> {
  return Object.hasOwn(TASK_STATUS_LABEL, status);
}

/** The visits booked for the job: kind, when, who. The buttons book the two the job needs. */
export function AppointmentsPanel({ view, className }: PanelProps) {
  const zone = useCompanyZone();
  const jobId = view.job.id;
  const whenFormat = useMemo(() => new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }), [zone]);
  const dayFormat = useMemo(() => new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'medium' }), [zone]);

  function whenText(appointment: AppointmentView): string {
    const start = new Date(appointment.startsAt);
    return appointment.allDay ? job.appointmentAllDay(dayFormat.format(start)) : whenFormat.format(start);
  }

  return (
    <Panel
      title={job.appointmentsTitle}
      className={className}
      padded={view.appointments.length === 0}
      actions={
        view.can.edit ? (
          <>
            <Button variant="default" size="sm" href={`/calendar/new?jobId=${jobId}&kind=inspection`}>
              {job.bookInspection}
            </Button>
            <Button variant="default" size="sm" href={`/calendar/new?jobId=${jobId}&kind=install`}>
              {job.bookInstall}
            </Button>
          </>
        ) : undefined
      }
    >
      {view.appointments.length === 0 ? (
        <EmptyPanel variant="inline" title={job.appointmentsEmpty} body={job.appointmentsEmptyBody} />
      ) : (
        <ul className={styles.rows}>
          {view.appointments.map((appointment) => (
            <li key={appointment.id}>
              <UiLink
                href={`/calendar/appointments/${appointment.id}`}
                className={styles.row}
                data-kind={appointment.kind}
                data-status={appointment.status}
              >
                <span className={styles.main}>
                  <span className={styles.strong}>{job.appointmentKind[appointment.kind]}</span>
                  {appointment.status !== 'scheduled' ? <Tag>{appointments.status[appointment.status]}</Tag> : null}
                </span>
                <span className={styles.mono}>{whenText(appointment)}</span>
                <span className={styles.muted}>{appointment.assigned?.name ?? jobs.unassigned}</span>
              </UiLink>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The quotes on the job, each a link to its editor; New quote starts a draft and opens it. */
export function QuotesPanel({ view, className }: PanelProps) {
  const jobId = view.job.id;
  const navigate = useNavigate();
  const toast = useToast();
  const createQuote = useCreateQuote(jobId);

  async function startQuote() {
    try {
      const { id } = await createQuote.mutateAsync();
      navigate(`/jobs/${jobId}/quotes/${id}`);
    } catch {
      toast.show(job.quoteCreateFailed, 'error');
    }
  }

  return (
    <Panel
      title={job.quotesTitle}
      className={className}
      padded={view.quotes.length === 0}
      actions={
        view.can.edit ? (
          <Button variant="default" size="sm" busy={createQuote.isPending} onClick={() => void startQuote()}>
            <Icon name="plus" size={16} />
            {job.newQuote}
          </Button>
        ) : undefined
      }
    >
      {view.quotes.length === 0 ? (
        <EmptyPanel variant="inline" title={job.quotesEmpty} body={job.quotesEmptyBody} />
      ) : (
        <ul className={styles.rows}>
          {view.quotes.map((quote) => (
            <li key={quote.id}>
              <UiLink href={`/jobs/${jobId}/quotes/${quote.id}`} className={styles.row} data-status={quote.status}>
                <span className={styles.main}>
                  <span className={styles.number}>{quote.number}</span>
                  {quote.status === 'final' ? (
                    <Tag tone="ok" icon="check">
                      {job.quoteStatus[quote.status]}
                    </Tag>
                  ) : (
                    <Tag icon="pen">{job.quoteStatus[quote.status]}</Tag>
                  )}
                </span>
                {view.can.seeValue ? <span className={styles.money}>{job.quoteTotal(formatDollars(quote.totalCents))}</span> : null}
              </UiLink>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** What the agents have drafted or done for this job: each a link to the plan. */
export function TasksPanel({ view, className }: PanelProps) {
  return (
    <Panel title={job.tasksTitle} className={className} padded={view.tasks.length === 0}>
      {view.tasks.length === 0 ? (
        <EmptyPanel variant="inline" title={job.tasksEmpty} body={job.tasksEmptyBody} />
      ) : (
        <ul className={styles.rows}>
          {view.tasks.map((task) => {
            const word = taskWord(task.status);
            return (
              <li key={task.id}>
                <UiLink href={`/approvals/${task.id}`} className={styles.row} data-status={task.status}>
                  <span className={styles.main}>
                    <span className={styles.strong}>{task.title}</span>
                  </span>
                  {word !== null ? <Tag>{word}</Tag> : null}
                </UiLink>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
