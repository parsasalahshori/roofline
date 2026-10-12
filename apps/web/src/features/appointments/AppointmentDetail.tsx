import type { AppointmentView } from '@roofline/shared';
import { Banner, Button, Pill, Sheet, UiLink } from '@roofline/ui';
import { useState } from 'react';
import { appointments } from '../../copy/appointments.ts';
import { formatDayLabel, formatRangeLabel, formatTime } from '../calendar/time.ts';
import { useCompany } from '../settings/api.ts';
import { useAppointmentAction, useCalendarProvider, useUpdateAppointment } from './api.ts';
import type { AppointmentDetailProps } from './types.ts';
import styles from './AppointmentDetail.module.css';

const FALLBACK_ZONE = 'America/Chicago';

/** The when line in the company zone: "Mon, Oct 13, 2:00 PM - 3:00 PM", or the day range (with "All day") for an all-day appointment. */
function whenLabel(appointment: AppointmentView, zone: string): string {
  const start = new Date(appointment.startsAt);
  const end = new Date(appointment.endsAt);
  if (appointment.allDay) {
    return `${formatRangeLabel(start, end, zone)} · ${appointments.allDay}`;
  }
  return `${formatDayLabel(start, zone)}, ${formatTime(start, zone)} - ${formatTime(end, zone)}`;
}

/**
 * One appointment: when, kind, person, links, address, notes and the calendar sync line. Reschedule
 * opens the form; Mark done, No-show and Cancel (after a confirm) post the action. Only the company's
 * editors see the actions, and only while the appointment is still scheduled.
 */
export function AppointmentDetail({ appointment, onReschedule }: AppointmentDetailProps) {
  const company = useCompany();
  const zone = company.data?.timezone ?? FALLBACK_ZONE;
  const provider = useCalendarProvider();
  const action = useAppointmentAction(appointment.id);
  const retry = useUpdateAppointment(appointment.id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);

  async function run(next: 'cancel' | 'complete' | 'no-show') {
    setActionFailed(false);
    setConfirmCancel(false);
    try {
      await action.mutateAsync(next);
    } catch {
      setActionFailed(true);
    }
  }

  async function retrySync() {
    setActionFailed(false);
    try {
      await retry.mutateAsync({ startsAt: appointment.startsAt, endsAt: appointment.endsAt });
    } catch {
      setActionFailed(true);
    }
  }

  const when = whenLabel(appointment, zone);
  const mapHref = `https://maps.apple.com/?q=${encodeURIComponent(appointment.addressLine ?? '')}`;
  const canAct = appointment.canEdit && appointment.status === 'scheduled';

  return (
    <div className={styles.detail}>
      <div className={styles.head}>
        <h2 className={styles.title}>{appointment.title}</h2>
        <Pill tone="accent">{appointments.status[appointment.status]}</Pill>
      </div>

      <dl className={styles.facts}>
        <dt>{appointments.detailTime}</dt>
        <dd>{when}</dd>

        <dt>{appointments.detailKind}</dt>
        <dd>{appointments.kind[appointment.kind]}</dd>

        <dt>{appointments.detailPerson}</dt>
        <dd>{appointment.assigned?.name ?? appointments.unassigned}</dd>

        {appointment.customerId !== null ? (
          <>
            <dt>{appointments.detailCustomer}</dt>
            <dd>
              <UiLink className={styles.link} href={`/customers/${appointment.customerId}`}>
                {appointment.customerName ?? appointments.detailCustomer}
              </UiLink>
            </dd>
          </>
        ) : null}

        {appointment.jobId !== null ? (
          <>
            <dt>{appointments.detailJob}</dt>
            <dd>
              <UiLink className={styles.link} href={`/jobs/${appointment.jobId}`}>
                {appointments.detailJob}
              </UiLink>
            </dd>
          </>
        ) : null}

        {appointment.addressLine !== null ? (
          <>
            <dt>{appointments.detailAddress}</dt>
            <dd>
              <UiLink className={styles.link} href={mapHref}>
                {appointment.addressLine}
              </UiLink>
            </dd>
          </>
        ) : null}

        {appointment.notes !== null && appointment.notes !== '' ? (
          <>
            <dt>{appointments.detailNotes}</dt>
            <dd>{appointment.notes}</dd>
          </>
        ) : null}
      </dl>

      {appointment.sync === 'synced' && provider !== null ? (
        <p className={styles.sync}>{appointments.sync.synced(provider)}</p>
      ) : null}
      {appointment.sync === 'pending' ? <p className={styles.sync}>{appointments.sync.pending}</p> : null}
      {appointment.sync === 'failed' ? (
        <Banner
          tone="warning"
          action={
            <Button variant="ghost" busy={retry.isPending} onClick={() => void retrySync()}>
              {appointments.sync.retry}
            </Button>
          }
        >
          {appointments.sync.failed}
        </Banner>
      ) : null}

      {actionFailed ? <Banner tone="danger">{appointments.actionError}</Banner> : null}

      {canAct ? (
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onReschedule}>
            {appointments.reschedule}
          </Button>
          <Button busy={action.isPending} onClick={() => void run('complete')}>
            {appointments.markDone}
          </Button>
          <Button variant="ghost" disabled={action.isPending} onClick={() => void run('no-show')}>
            {appointments.noShow}
          </Button>
          <Button variant="danger" disabled={action.isPending} onClick={() => setConfirmCancel(true)}>
            {appointments.cancel}
          </Button>
        </div>
      ) : null}

      <Sheet
        open={confirmCancel}
        title={appointments.cancelConfirm}
        onClose={() => setConfirmCancel(false)}
        closeLabel={appointments.close}
        footer={
          <div className={styles.footer}>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              {appointments.cancelNo}
            </Button>
            <Button variant="danger" busy={action.isPending} onClick={() => void run('cancel')}>
              {appointments.cancelYes}
            </Button>
          </div>
        }
      >
        <p className={styles.sync}>{when}</p>
      </Sheet>
    </div>
  );
}
