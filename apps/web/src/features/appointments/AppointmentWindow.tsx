import { EmptyState } from '@roofline/ui';
import { appointments } from '../../copy/appointments.ts';

/** The appointment screen, new or existing. Task 18 skeleton: one line until the form lands. */
export function AppointmentWindow() {
  return <EmptyState title={appointments.comingSoon} />;
}
