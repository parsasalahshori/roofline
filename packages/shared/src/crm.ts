import type {
  JobStage,
  JobSource,
  CustomerSource,
  ConsentStatus,
  TaskStatus,
  MessageStatus,
  ActivitySubjectType,
} from './enums.ts';
import type { Pricebook, Scope, Calculation } from './pricing.ts';
import type { BoardStage } from './pipeline.ts';
import type { ConfirmedVia } from './front-desk.ts';
import type {
  AppointmentKind,
  AppointmentStatus,
  AppointmentSource,
  CalendarProvider,
  CalendarConnectionStatus,
  QuoteStatus,
  WorkHours,
} from './availability.ts';

export type MemberRef = { userId: string; name: string };

export type JobCard = {
  id: string;
  customerId: string;
  customerName: string;
  propertyId: string;
  addressLine: string;
  stage: JobStage;
  valueCents: number | null;
  assigned: MemberRef | null;
  daysInStage: number;
  stuck: boolean;
  nextStep: string | null;
  nextStepOn: string | null;
  updatedAt: string;
};

export type BoardColumn = {
  stage: BoardStage;
  count: number;
  totalCents: number | null;
  jobs: JobCard[];
};

export type BoardView = {
  columns: BoardColumn[];
  lost: { count: number };
};

export type HomeSummary = {
  id: string;
  addressLine: string;
  city: string;
  state: string;
  zip: string;
  located: boolean;
  jobs: { id: string; stage: JobStage }[];
};

export type AppointmentView = {
  id: string;
  kind: AppointmentKind;
  title: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  assigned: MemberRef | null;
  jobId: string | null;
  customerId: string | null;
  customerName: string | null;
  propertyId: string | null;
  addressLine: string | null;
  notes: string | null;
  source: AppointmentSource;
  sync: 'none' | 'synced' | 'pending' | 'failed';
  /** When the customer (or a person) confirmed the visit, and how. Both null until confirmed. */
  confirmedAt: string | null;
  confirmedVia: ConfirmedVia | null;
  canEdit: boolean;
};

export type QuoteSummary = {
  id: string;
  number: string;
  status: QuoteStatus;
  totalCents: number;
  updatedAt: string;
};

export type JobView = {
  job: JobCard & {
    source: JobSource;
    lostReason: string | null;
    stageChangedAt: string;
    archived: boolean;
    createdAt: string;
  };
  customer: { id: string; displayName: string; phone: string | null; email: string | null };
  home: HomeSummary;
  appointments: AppointmentView[];
  quotes: QuoteSummary[];
  tasks: { id: string; title: string; status: TaskStatus }[];
  can: { edit: boolean; seeValue: boolean; archive: boolean };
};

export type CustomerView = {
  customer: {
    id: string;
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    phones: { e164: string; label: string | null; primary: boolean }[];
    emails: string[];
    tags: string[];
    consent: ConsentStatus;
    doNotContact: boolean;
    source: CustomerSource;
    archived: boolean;
    createdAt: string;
  };
  homes: HomeSummary[];
  jobs: JobCard[];
  upcoming: AppointmentView[];
  can: { edit: boolean; changeConsent: boolean; archive: boolean };
};

export type TimelineItem = {
  id: string;
  at: string;
  type: 'activity' | 'text';
  kind: string;
  summary: string;
  actor: { type: 'user' | 'agent' | 'system'; name: string | null };
  subject: { type: ActivitySubjectType; id: string };
  text: { direction: 'in' | 'out'; body: string; status: MessageStatus } | null;
};

export type TimelinePage = {
  items: TimelineItem[];
  nextBefore: string | null;
};

export type TodayView = {
  appointments: AppointmentView[];
  followUps: JobCard[];
};

export type CalendarConnectionView = {
  provider: CalendarProvider | null;
  status: CalendarConnectionStatus | null;
  accountEmail: string | null;
  calendarId: string | null;
  calendarName: string | null;
  lastSyncedAt: string | null;
  configured: Record<CalendarProvider, boolean>;
};

export type ScheduleSettings = {
  workHours: WorkHours;
  travelBufferMinutes: number;
  minNoticeMinutes: number;
  stuckAfterDays: number;
};

export type QuoteDefaults = {
  wastePercent: number;
  markupPercent: number;
  taxPercent: number;
  material: Scope['material'];
};

export type PricebookView = {
  prices: Pricebook;
  defaults: QuoteDefaults;
  isExample: boolean;
};

export type QuoteMeasurement = {
  source: 'manual';
  areaSqFt: number;
  areaType: 'surface' | 'footprint';
  pitch: number;
  notes: string | null;
};

export type QuoteView = {
  id: string;
  jobId: string;
  number: string;
  status: QuoteStatus;
  measurement: QuoteMeasurement;
  scope: Scope;
  prices: Pricebook;
  calculation: Calculation;
  notes: string | null;
  validUntil: string;
  createdAt: string;
  finalizedAt: string | null;
  canEdit: boolean;
};
