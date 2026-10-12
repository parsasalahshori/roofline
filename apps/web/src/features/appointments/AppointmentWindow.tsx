import { EmptyState, Skeleton } from '@roofline/ui';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { appointments } from '../../copy/appointments.ts';
import { AppointmentDetail } from './AppointmentDetail.tsx';
import { AppointmentForm } from './AppointmentForm.tsx';
import { useAppointment } from './api.ts';

/** The appointment screen: the new form at /calendar/new, or an existing appointment at /calendar/appointments/:appointmentId. */
export function AppointmentWindow() {
  const { appointmentId } = useParams();
  const navigate = useNavigate();
  if (appointmentId === undefined) {
    return <AppointmentForm onDone={(saved) => navigate(`/calendar/appointments/${saved.id}`)} />;
  }
  return <ExistingAppointment key={appointmentId} appointmentId={appointmentId} />;
}

/** One appointment: its detail, or the form when it is being rescheduled. */
function ExistingAppointment({ appointmentId }: { appointmentId: string }) {
  const query = useAppointment(appointmentId);
  const [rescheduling, setRescheduling] = useState(false);

  if (query.isPending) {
    return <Skeleton lines={3} height="40px" />;
  }
  if (query.isError || query.data === undefined) {
    return <EmptyState title={appointments.loadError} />;
  }
  const appointment = query.data;
  if (rescheduling) {
    return <AppointmentForm existing={appointment} onDone={() => setRescheduling(false)} />;
  }
  return <AppointmentDetail appointment={appointment} onReschedule={() => setRescheduling(true)} />;
}
