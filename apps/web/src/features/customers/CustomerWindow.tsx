import { isTimeZone, type CustomerView, type AppointmentView } from '@roofline/shared';
import { Button, EmptyState, Pill, Skeleton, UiLink, useToast } from '@roofline/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { customers } from '../../copy/customers.ts';
import { jobs } from '../../copy/jobs.ts';
import { AddHomeSheet } from '../create/AddHomeSheet.tsx';
import { JobCardView } from '../jobs/JobCardView.tsx';
import { JobsTabs } from '../jobs/JobsTabs.tsx';
import { useCompany } from '../settings/api.ts';
import { Timeline } from '../timeline/Timeline.tsx';
import { type Recent, useRecordRecent } from '../../shell/recents.ts';
import { customerKeys, useArchiveCustomer, useCustomerView } from './api.ts';
import { CustomerHeader } from './CustomerHeader.tsx';
import { CustomerHomes } from './CustomerHomes.tsx';
import { EditCustomerSheet } from './EditCustomerSheet.tsx';
import styles from './CustomerWindow.module.css';

/** The zone used until the company's own is known, and when the company's is not a zone the browser knows. */
const FALLBACK_ZONE = 'America/Chicago';

function zoneOf(zone: string | undefined): string {
  return zone !== undefined && isTimeZone(zone) ? zone : FALLBACK_ZONE;
}

/** One customer's window: the tabs, then the customer once it has loaded (or why it has not). */
export function CustomerWindow() {
  const { customerId = '' } = useParams();
  const { data, error, isError, refetch } = useCustomerView(customerId);

  let body: ReactNode;
  if (data !== undefined) {
    body = <CustomerBody view={data} />;
  } else if (isError) {
    body =
      error instanceof ApiError && error.status === 404 ? (
        <EmptyState title={customers.window.notFound} />
      ) : (
        <EmptyState
          title={customers.window.loadFailed}
          action={
            <Button variant="ghost" onClick={() => void refetch()}>
              {customers.window.retry}
            </Button>
          }
        />
      );
  } else {
    body = (
      <div className={styles.loading} aria-busy="true">
        <p className={styles.muted}>{customers.window.loading}</p>
        <Skeleton lines={4} />
      </div>
    );
  }

  return (
    <>
      <JobsTabs />
      {body}
    </>
  );
}

/** Everything about a loaded customer. Its own component so that the recents entry is recorded only once the customer is known. */
function CustomerBody({ view }: { view: CustomerView }) {
  const { customer, can } = view;
  const toast = useToast();
  const queryClient = useQueryClient();
  const archive = useArchiveCustomer(customer.id);
  const company = useCompany();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const recent = useMemo<Recent>(() => ({ kind: 'customer', id: customer.id, label: customer.displayName }), [customer.id, customer.displayName]);
  useRecordRecent(recent);

  const zone = zoneOf(company.data?.timezone);
  const dateTimeFormat = useMemo(() => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }), [zone]);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: zone }), [zone]);
  const addingHome = searchParams.get('addHome') === '1';

  async function setArchived(archived: boolean) {
    try {
      await archive.mutateAsync(archived);
      setConfirming(false);
      toast.show(archived ? customers.window.archivedToast : customers.window.restoredToast, 'success');
    } catch {
      toast.show(customers.window.actionFailed, 'error');
    }
  }

  function closeAddHome() {
    const next = new URLSearchParams(searchParams);
    next.delete('addHome');
    setSearchParams(next, { replace: true });
    void queryClient.invalidateQueries({ queryKey: customerKeys.all });
  }

  function whenOf(appointment: AppointmentView): string {
    return appointment.allDay ? dateFormat.format(new Date(appointment.startsAt)) : dateTimeFormat.format(new Date(appointment.startsAt));
  }

  return (
    <div className={styles.page}>
      <CustomerHeader view={view} />
      {customer.archived ? <Pill tone="neutral">{customers.window.archived}</Pill> : null}

      <div role="group" aria-label={customers.window.actionsLabel} className={styles.actions}>
        <Button href={`/jobs/new?customerId=${customer.id}`}>{customers.window.newJob}</Button>
        <Button variant="ghost" href={`/customers/${customer.id}?addHome=1`}>
          {customers.window.addHome}
        </Button>
        <Button variant="ghost" href={`/calendar/new?customerId=${customer.id}`}>
          {customers.window.bookAppointment}
        </Button>
        {can.edit ? (
          <Button variant="ghost" onClick={() => setEditing(true)}>
            {customers.window.edit}
          </Button>
        ) : null}
        {can.archive && customer.archived ? (
          <Button variant="ghost" busy={archive.isPending} onClick={() => void setArchived(false)}>
            {customers.window.restore}
          </Button>
        ) : null}
        {can.archive && !customer.archived && !confirming ? (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            {customers.window.archive}
          </Button>
        ) : null}
      </div>

      {can.archive && !customer.archived && confirming ? (
        <section aria-label={customers.window.archiveConfirm} className={styles.confirm}>
          <p className={styles.confirmText}>{customers.window.archiveConfirm}</p>
          <div className={styles.confirmActions}>
            <Button busy={archive.isPending} onClick={() => void setArchived(true)}>
              {customers.window.archiveYes}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {customers.window.archiveNo}
            </Button>
          </div>
        </section>
      ) : null}

      <Section title={customers.window.homesHeading}>
        <CustomerHomes homes={view.homes} />
      </Section>

      <Section title={customers.window.jobsHeading}>
        {view.jobs.length === 0 ? (
          <p className={styles.muted}>{customers.window.noJobs}</p>
        ) : (
          <ul className={styles.homeList}>
            {view.jobs.map((job) => (
              <li key={job.id} className={styles.jobRow}>
                <div className={styles.jobCard}>
                  <JobCardView job={job} />
                </div>
                <Pill tone="neutral" href={`/jobs/${job.id}`}>
                  {jobs.stage[job.stage]}
                </Pill>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={customers.window.upcomingHeading}>
        {view.upcoming.length === 0 ? (
          <p className={styles.muted}>{customers.window.noUpcoming}</p>
        ) : (
          <ul className={styles.homeList}>
            {view.upcoming.map((appointment) => (
              <li key={appointment.id}>
                <UiLink href={`/calendar/appointments/${appointment.id}`} className={styles.appointment}>
                  <strong>{appointment.title}</strong>
                  <span className={styles.appointmentMeta}>{whenOf(appointment)}</span>
                  {appointment.addressLine !== null ? <span className={styles.appointmentMeta}>{appointment.addressLine}</span> : null}
                </UiLink>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={customers.window.timelineHeading}>
        <Timeline customerId={customer.id} />
      </Section>

      {editing ? <EditCustomerSheet view={view} onDone={() => setEditing(false)} /> : null}
      {addingHome ? <AddHomeSheet customerId={customer.id} onDone={closeAddHome} /> : null}
    </div>
  );
}

/** A labelled part of the window: its heading names the region. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <h3 id={headingId} className={styles.sectionHeading}>
        {title}
      </h3>
      {children}
    </section>
  );
}
