import type { AppointmentKind, AppointmentView } from '@roofline/shared';

/** One suggested time: GET /api/calendar/availability answers `{ slots: Slot[] }`, sorted by start. `userIds` = members free at that start. */
export type Slot = { start: string; end: string; userIds: string[] };

/** Body of POST /api/appointments and PATCH /api/appointments/:id (every field of PATCH optional). Instants are ISO strings with Z. */
export type AppointmentBody = {
  kind: AppointmentKind;
  startsAt: string;
  endsAt?: string;
  allDay?: boolean;
  jobId?: string | null;
  customerId?: string | null;
  propertyId?: string | null;
  assignedUserId?: string | null;
  notes?: string | null;
};

/** POST answers 201 with jobMoved; PATCH answers 200 without it. */
export type SaveResult = { appointment: AppointmentView; warnings: string[]; jobMoved?: boolean };

export type AvailabilityQuery = { userId?: string; kind: AppointmentKind; propertyId?: string; from: string; to: string };

/** Props of SuggestedTimes.tsx (Package B). `onPick` receives the slot and the member chosen for it (the first of slot.userIds, or the asked-for userId). */
export type SuggestedTimesProps = {
  kind: AppointmentKind;
  /** Rep: their own id (only their times are asked). Owner/office: the person picked in the form, or '' for anyone. */
  userId: string;
  propertyId: string;
  zone: string;
  onPick: (slot: Slot, userId: string) => void;
};

/** Props of ConflictWarnings.tsx (Package B): the post-save warning banner. */
export type ConflictWarningsProps = {
  warnings: string[];
  onKeep: () => void;
  onChange: () => void;
};

/** Props of AppointmentForm.tsx (Package A). */
export type AppointmentFormProps = {
  /** Present when rescheduling: the form starts from this appointment and saves with PATCH. */
  existing?: AppointmentView;
  /** Called after a successful save, once the warnings (if any) were answered (Keep it). */
  onDone: (appointment: AppointmentView) => void;
};

/** Props of AppointmentDetail.tsx (Package C). */
export type AppointmentDetailProps = {
  appointment: AppointmentView;
  /** "Reschedule" pressed: the window shows the form for this appointment. */
  onReschedule: () => void;
};
