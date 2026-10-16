import type { AppointmentStatus, AppointmentView } from '@roofline/shared';
import { Avatar, Banner, Button, Icon, Panel, Sheet, Tag, UiLink, type IconName, type TagTone } from '@roofline/ui';
import { useState } from 'react';
import { appointments } from '../../copy/appointments.ts';
import { formatDayLabel, formatRangeLabel, formatTime } from '../calendar/time.ts';
import { useCompany } from '../settings/api.ts';
import { useAppointmentAction, useCalendarProvider, useUpdateAppointment } from './api.ts';
import type { AppointmentDetailProps } from './types.ts';
import styles from './AppointmentDetail.module.css';

const FALLBACK_ZONE = 'America/Chicago';

/** How each status is told: a word, a glyph and a tone, never the tone alone. */
const STATUS: Record<AppointmentStatus, { tone: TagTone; icon: IconName }> = {
  scheduled: { tone: 'brand', icon: 'cal' },
  completed: { tone: 'ok', icon: 'check' },
  canceled: { tone: 'neutral', icon: 'x' },
  no_show: { tone: 'warn', icon: 'alert' },
};

/** The day, and the hours (or "All day") of an appointment in the company zone: "Tue, Oct 13" over "2:00 PM - 3:00 PM". */
function whenParts(appointment: AppointmentView, zone: string): { day: string; hours: string | null } {
  const start = new Date(appointment.startsAt);
  const end = new Date(appointment.endsAt);
  if (appointment.allDay) return { day: formatRangeLabel(start, end, zone), hours: null };
  return { day: formatDayLabel(start, zone), hours: `${formatTime(start, zone)} - ${formatTime(end, zone)}` };
}

/** The length of a timed appointment in minutes. */
function lengthMinutes(appointment: AppointmentView): number {
  return Math.round((Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60_000);
}

/**
 * One appointment: its name and status over the actions, when it is, then the kind, person, customer, job, address and notes.
 * Reschedule opens the form; Mark done, No-show and Cancel (after a confirm) post the action. Only the company's
 * editors see the actions, and only while the appointment is still scheduled. The sync with the calendar is a tag, or a banner
 * with Try again when it failed.
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

  const when = whenParts(appointment, zone);
  const mapHref = `https://maps.apple.com/?q=${encodeURIComponent(appointment.addressLine ?? '')}`;
  const canAct = appointment.canEdit && appointment.status === 'scheduled';
  const status = STATUS[appointment.status];
  const hasNotes = appointment.notes !== null && appointment.notes !== '';

  return (
    <div className={styles.detail}>
      <header className={styles.head}>
        <div className={styles.titles}>
          <h2 className={styles.title}>{appointment.title}</h2>
          <div className={styles.tags}>
            <Tag tone={status.tone} icon={status.icon}>
              {appointments.status[appointment.status]}
            </Tag>
            {appointment.source === 'front_desk' ? (
              <Tag tone="neutral" icon="phone">
                {appointments.bookedByFrontDesk}
              </Tag>
            ) : null}
            {appointment.confirmedAt !== null ? (
              <Tag tone="ok" icon="check">
                {appointments.confirmed[appointment.confirmedVia ?? 'manual']}
              </Tag>
            ) : null}
            {appointment.sync === 'synced' && provider !== null ? (
              <Tag tone="ok" icon="check">
                {appointments.sync.synced(provider)}
              </Tag>
            ) : null}
            {appointment.sync === 'pending' ? (
              <Tag tone="neutral" icon="clock">
                {appointments.sync.pending}
              </Tag>
            ) : null}
          </div>
        </div>
        {canAct ? (
          <div className={styles.actions} role="group" aria-label={appointments.actionsLabel}>
            <Button variant="default" onClick={onReschedule}>
              {appointments.reschedule}
            </Button>
            <Button variant="primary" busy={action.isPending} onClick={() => void run('complete')}>
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
      </header>

      {appointment.sync === 'failed' ? (
        <Banner
          tone="warning"
          action={
            <Button variant="default" size="sm" busy={retry.isPending} onClick={() => void retrySync()}>
              {appointments.sync.retry}
            </Button>
          }
        >
          {appointments.sync.failed}
        </Banner>
      ) : null}

      {actionFailed ? <Banner tone="danger">{appointments.actionError}</Banner> : null}

      <div className={styles.grid}>
        <Panel title={appointments.detailTime} headingLevel={3}>
          <p className={styles.day}>{when.day}</p>
          {when.hours !== null ? (
            <>
              <p className={styles.hours}>{when.hours}</p>
              <p className={styles.length}>{appointments.duration(lengthMinutes(appointment))}</p>
            </>
          ) : (
            <p className={styles.length}>{appointments.allDay}</p>
          )}
        </Panel>

        <Panel title={appointments.detailHeading} headingLevel={3}>
          <dl className={styles.facts}>
            <dt>{appointments.detailKind}</dt>
            <dd>{appointments.kind[appointment.kind]}</dd>

            <dt>{appointments.detailPerson}</dt>
            <dd>
              {appointment.assigned !== null ? (
                <span className={styles.person}>
                  <Avatar name={appointment.assigned.name} size={28} />
                  {appointment.assigned.name}
                </span>
              ) : (
                <span className={styles.nobody}>{appointments.unassigned}</span>
              )}
            </dd>

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
                    <Icon name="arrow" size={16} />
                  </UiLink>
                </dd>
              </>
            ) : null}

            {appointment.addressLine !== null ? (
              <>
                <dt>{appointments.detailAddress}</dt>
                <dd>
                  <UiLink className={styles.link} href={mapHref}>
                    <Icon name="pin" size={16} />
                    {appointment.addressLine}
                  </UiLink>
                </dd>
              </>
            ) : null}

            {hasNotes ? (
              <>
                <dt>{appointments.detailNotes}</dt>
                <dd className={styles.notes}>{appointment.notes}</dd>
              </>
            ) : null}
          </dl>
        </Panel>
      </div>

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
        <p className={styles.sheetTitle}>{appointment.title}</p>
        <p className={styles.sheetWhen}>
          {when.day}
          {when.hours !== null ? `, ${when.hours}` : ''}
        </p>
      </Sheet>
    </div>
  );
}
