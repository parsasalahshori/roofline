import { isTimeZone, type AppointmentView, type CustomerView, type JobCard } from '@roofline/shared';
import { Button, Icon, Panel, Skeleton, Tag, UiLink, useToast } from '@roofline/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { customers } from '../../copy/customers.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { AddHomeSheet } from '../create/AddHomeSheet.tsx';
import { DetailPage } from '../jobs/DetailPage.tsx';
import { formatDollars } from '../jobs/format.ts';
import { Aging } from '../jobs/JobCardView.tsx';
import { StageTag } from '../jobs/StageTag.tsx';
import { EmptyPanel, LoadError } from '../jobs/states.tsx';
import { useCompany } from '../settings/api.ts';
import { Timeline } from '../timeline/Timeline.tsx';
import { type Recent, useRecordRecent } from '../../shell/recents.ts';
import { customerKeys, useArchiveCustomer, useCustomerView } from './api.ts';
import { ConsentChip } from './ConsentChip.tsx';
import { CustomerContact } from './CustomerContact.tsx';
import { CustomerHomes } from './CustomerHomes.tsx';
import { EditCustomerSheet } from './EditCustomerSheet.tsx';
import styles from './CustomerWindow.module.css';

/** The zone used until the company's own is known, and when the company's is not a zone the browser knows. */
const FALLBACK_ZONE = 'America/Chicago';

function zoneOf(zone: string | undefined): string {
  return zone !== undefined && isTimeZone(zone) ? zone : FALLBACK_ZONE;
}

const CUSTOMERS_CRUMB = { label: WINDOW_COPY.customers.title, href: '/customers' } as const;

/** The panels' shape while the customer loads: a head and two columns of panels. */
function CustomerSkeleton() {
  return (
    <div role="status" aria-label={customers.window.loading} className={styles.grid} aria-busy="true">
      <div className={styles.side}>
        {[0, 1].map((panel) => (
          <div key={panel} className={styles.skeletonPanel}>
            <Skeleton lines={4} />
          </div>
        ))}
      </div>
      <div className={styles.main}>
        {[0, 1].map((panel) => (
          <div key={panel} className={styles.skeletonPanel}>
            <Skeleton lines={3} height="40px" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One customer's page: its head, panels and sheets once the customer has loaded (or why it has not). */
export function CustomerWindow() {
  const { customerId = '' } = useParams();
  const { data, error, isError, isFetching, refetch } = useCustomerView(customerId);

  if (data !== undefined) return <CustomerBody key={data.customer.id} view={data} />;

  const crumbs = [CUSTOMERS_CRUMB, { label: customers.window.crumbCustomer }];
  if (isError) {
    return (
      <DetailPage app="customers" crumbs={crumbs}>
        {error instanceof ApiError && error.status === 404 ? (
          <EmptyPanel
            title={customers.window.notFound}
            body={customers.window.notFoundBody}
            action={
              <Button href="/customers" variant="default">
                {customers.window.backToCustomers}
              </Button>
            }
          />
        ) : (
          <LoadError
            tag={customers.window.errorTag}
            title={customers.window.loadFailed}
            retry={customers.window.retry}
            busy={isFetching}
            onRetry={() => void refetch()}
          />
        )}
      </DetailPage>
    );
  }

  return (
    <DetailPage app="customers" crumbs={crumbs}>
      <CustomerSkeleton />
    </DetailPage>
  );
}

/** One job of the customer: its stage, address, value and days, as a link to the job. */
function JobRow({ job }: { job: JobCard }) {
  return (
    <li>
      <UiLink href={`/jobs/${job.id}`} className={styles.jobRow}>
        <span className={styles.jobMain}>
          <span className={styles.jobAddress}>{job.addressLine}</span>
          <StageTag stage={job.stage} />
        </span>
        <span className={styles.jobFacts}>
          {job.valueCents !== null ? <span className={styles.value}>{formatDollars(job.valueCents)}</span> : null}
          <Aging days={job.daysInStage} stuck={job.stuck} />
        </span>
      </UiLink>
    </li>
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
    <DetailPage
      app="customers"
      title={customer.displayName}
      crumbs={[CUSTOMERS_CRUMB, { label: customer.displayName }]}
      subtitle={
        <span className={styles.status}>
          <ConsentChip status={customer.consent} />
          {customer.doNotContact ? (
            <Tag tone="bad" icon="alert">
              {customers.doNotContact}
            </Tag>
          ) : null}
          {customer.archived ? <Tag>{customers.window.archived}</Tag> : null}
        </span>
      }
      actions={
        <div role="group" aria-label={customers.window.actionsLabel} className={styles.actions}>
          <Button href={`/jobs/new?customerId=${customer.id}`} variant="primary">
            <Icon name="plus" size={16} />
            {customers.window.newJob}
          </Button>
          {can.edit ? (
            <Button variant="default" onClick={() => setEditing(true)}>
              <Icon name="pen" size={16} />
              {customers.window.edit}
            </Button>
          ) : null}
          {can.archive && customer.archived ? (
            <Button variant="default" busy={archive.isPending} onClick={() => void setArchived(false)}>
              {customers.window.restore}
            </Button>
          ) : null}
          {can.archive && !customer.archived && !confirming ? (
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              {customers.window.archive}
            </Button>
          ) : null}
        </div>
      }
    >
      {can.archive && !customer.archived && confirming ? (
        <section aria-label={customers.window.archiveConfirm} className={styles.confirm}>
          <p className={styles.confirmText}>{customers.window.archiveConfirm}</p>
          <div className={styles.confirmActions}>
            <Button variant="ink" busy={archive.isPending} onClick={() => void setArchived(true)}>
              {customers.window.archiveYes}
            </Button>
            <Button variant="default" onClick={() => setConfirming(false)}>
              {customers.window.archiveNo}
            </Button>
          </div>
        </section>
      ) : null}

      <div className={styles.grid}>
        <div className={styles.side}>
          <CustomerContact view={view} />
          <CustomerHomes homes={view.homes} addHomeHref={`/customers/${customer.id}?addHome=1`} />
        </div>

        <div className={styles.main}>
          <Panel title={customers.window.jobsHeading} className={styles.jobs} padded={view.jobs.length === 0}>
            {view.jobs.length === 0 ? (
              <EmptyPanel
                variant="inline"
                title={customers.window.noJobs}
                body={customers.window.noJobsBody}
                action={
                  <Button href={`/jobs/new?customerId=${customer.id}`} variant="primary" size="sm">
                    <Icon name="plus" size={16} />
                    {customers.window.newJob}
                  </Button>
                }
              />
            ) : (
              <ul className={styles.rows}>
                {view.jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title={customers.window.upcomingHeading}
            className={styles.upcoming}
            padded={view.upcoming.length === 0}
            actions={
              <Button href={`/calendar/new?customerId=${customer.id}`} variant="default" size="sm">
                <Icon name="cal" size={16} />
                {customers.window.bookAppointment}
              </Button>
            }
          >
            {view.upcoming.length === 0 ? (
              <EmptyPanel variant="inline" title={customers.window.noUpcoming} body={customers.window.noUpcomingBody} />
            ) : (
              <ul className={styles.rows}>
                {view.upcoming.map((appointment) => (
                  <li key={appointment.id}>
                    <UiLink href={`/calendar/appointments/${appointment.id}`} className={styles.appointment}>
                      <strong>{appointment.title}</strong>
                      <span className={styles.when}>{whenOf(appointment)}</span>
                      {appointment.addressLine !== null ? <span className={styles.muted}>{appointment.addressLine}</span> : null}
                    </UiLink>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={customers.window.timelineHeading} className={styles.timeline}>
            <Timeline customerId={customer.id} />
          </Panel>
        </div>
      </div>

      {editing ? <EditCustomerSheet view={view} onDone={() => setEditing(false)} /> : null}
      {addingHome ? <AddHomeSheet customerId={customer.id} onDone={closeAddHome} /> : null}
    </DetailPage>
  );
}
