import { useId, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { isTimeZone, type AppointmentView, type JobView, type TaskStatus } from '@roofline/shared';
import type { ProposalView } from '@roofline/shared';
import { Button, EmptyState, Skeleton, UiLink, useToast } from '@roofline/ui';
import { job } from '../../copy/job.ts';
import { proposals } from '../../copy/proposals.ts';
import { jobs } from '../../copy/jobs.ts';
import { TASK_STATUS_LABEL } from '../../copy/status.ts';
import { useMe } from '../../api/hooks.ts';
import { useCompany } from '../settings/api.ts';
import { useCopyLink } from '../proposals/api.ts';
import { formatDollars } from '../jobs/JobCardView.tsx';
import { Timeline } from '../timeline/Timeline.tsx';
import { useMeasure } from '../estimator/api.ts';
import { useCreateQuote, useJobProposals } from './api.ts';
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

/** The lowest enabled option's total as a line, or null when there is none. Instant numbers say Estimate. */
function proposalFromText(proposal: ProposalView): string | null {
  const totals = proposal.options.filter((option) => option.enabled).map((option) => option.totalCents);
  if (totals.length === 0) return null;
  const money = proposals.money(Math.min(...totals));
  return proposal.basis === 'exact' ? job.proposalExactFrom(money) : job.proposalFrom(money);
}

/** One proposal row: the link, plus a Copy link button for staff who may hand the link out. */
function ProposalRow({ proposal, from, canCopy }: { proposal: ProposalView; from: string | null; canCopy: boolean }) {
  const copyLink = useCopyLink(proposal.id);
  return (
    <li className={styles.proposalRow}>
      <UiLink href={'/estimator/proposals/' + proposal.id} className={styles.link} data-status={proposal.status}>
        <span className={styles.strong}>{proposal.number}</span>
        <span className={styles.meta}>{proposals.statusLabelFor(proposal.status)}</span>
        {from !== null ? <span className={styles.meta}>{from}</span> : null}
      </UiLink>
      {canCopy ? (
        <Button variant="ghost" busy={copyLink.isPending} onClick={() => copyLink.mutate()}>
          {proposals.copyLink}
        </Button>
      ) : null}
    </li>
  );
}

/** The four blocks under the header: appointments, quotes, agent tasks and the timeline. */
export function JobSections({ view }: JobSectionsProps) {
  const zone = useCompanyZone();
  const navigate = useNavigate();
  const toast = useToast();
  const createQuote = useCreateQuote(view.job.id);
  const jobId = view.job.id;
  const measure = useMeasure();
  const jobProposals = useJobProposals(jobId);
  const me = useMe();
  const canCopyLinks = me.data?.role === 'owner' || me.data?.role === 'office';

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

  async function startProposal() {
    try {
      const measurement = await measure.mutateAsync({ propertyId: view.home.id });
      // Ruling EM: the measure window builds the proposal on this job
      navigate('/estimator/measure/' + measurement.id, { state: { jobId } });
    } catch {
      toast.show(job.proposalStartFailed, 'error');
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

      <Section title={job.proposalsTitle} name="proposals">
        {view.can.edit ? (
          <div className={styles.actions}>
            <Button variant="primary" busy={measure.isPending} onClick={() => void startProposal()}>
              {job.newProposal}
            </Button>
          </div>
        ) : null}
        {jobProposals.isPending ? (
          <Skeleton lines={2} />
        ) : jobProposals.isError ? (
          <p>{job.proposalsLoadFailed}</p>
        ) : jobProposals.data.length === 0 ? (
          <EmptyState title={job.proposalsEmpty} />
        ) : (
          <ul className={styles.list}>
            {jobProposals.data.map((proposal) => {
              const from = view.can.seeValue ? proposalFromText(proposal) : null;
              return (
                <ProposalRow
                  key={proposal.id}
                  proposal={proposal}
                  from={from}
                  canCopy={canCopyLinks && proposal.status !== 'draft'}
                />
              );
            })}
          </ul>
        )}
      </Section>

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
