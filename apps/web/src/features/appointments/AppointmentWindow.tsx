import { Banner, Button, Skeleton } from '@roofline/ui';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { appointments } from '../../copy/appointments.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { AppointmentDetail } from './AppointmentDetail.tsx';
import { AppointmentForm } from './AppointmentForm.tsx';
import { useAppointment } from './api.ts';
import styles from './AppointmentWindow.module.css';

/** The page around an appointment: the calendar's trail, then the appointment. The form and the detail draw their own heading. */
function AppointmentPage({ crumb, children }: { crumb: string; children: ReactNode }) {
  return (
    <AppPage
      app="calendar"
      bare
      layout="flow"
      crumbs={[{ label: WINDOW_COPY.calendar.title, href: '/calendar' }, { label: crumb }]}
    >
      {children}
    </AppPage>
  );
}

/** The appointment screen: the new form at /calendar/new, or an existing appointment at /calendar/appointments/:appointmentId. */
export function AppointmentWindow() {
  const { appointmentId } = useParams();
  const navigate = useNavigate();
  if (appointmentId === undefined) {
    return (
      <AppointmentPage crumb={appointments.newTitle}>
        <AppointmentForm onDone={(saved) => navigate(`/calendar/appointments/${saved.id}`)} />
      </AppointmentPage>
    );
  }
  return <ExistingAppointment key={appointmentId} appointmentId={appointmentId} />;
}

/** One appointment: its detail, or the form when it is being rescheduled. */
function ExistingAppointment({ appointmentId }: { appointmentId: string }) {
  const query = useAppointment(appointmentId);
  const [rescheduling, setRescheduling] = useState(false);

  if (query.isPending) {
    return (
      <AppointmentPage crumb={appointments.crumb}>
        <div className={styles.skeleton} role="status" aria-label={appointments.loading}>
          <Skeleton width="40%" height="28px" />
          <div className={styles.skeletonGrid}>
            <Skeleton height="120px" />
            <Skeleton height="200px" />
          </div>
        </div>
      </AppointmentPage>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <AppointmentPage crumb={appointments.crumb}>
        <Banner
          tone="danger"
          action={
            <Button variant="default" size="sm" onClick={() => void query.refetch()}>
              {appointments.tryAgain}
            </Button>
          }
        >
          {appointments.loadError}
        </Banner>
      </AppointmentPage>
    );
  }
  const appointment = query.data;
  return (
    <AppointmentPage crumb={appointment.title}>
      {rescheduling ? (
        <AppointmentForm existing={appointment} onDone={() => setRescheduling(false)} onCancel={() => setRescheduling(false)} />
      ) : (
        <AppointmentDetail appointment={appointment} onReschedule={() => setRescheduling(true)} />
      )}
    </AppointmentPage>
  );
}
