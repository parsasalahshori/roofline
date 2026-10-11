import type {
  Agent,
  ApprovalClass,
  CompanyStatus,
  JobStage,
  Role,
  StepPreview,
  StepResult,
  StepStatus,
  StepType,
  TaskStatus,
} from '@roofline/shared';

/*
 * The shapes the server answers with, as the browser reads them. They are written out here, not
 * imported from the server, because the web app never imports the server's packages (it asks over
 * HTTP). Ids and dates are strings: JSON has no other way to carry them.
 */

export type User = { id: string; email: string; name: string; emailVerified: boolean };
export type CompanySummary = { id: string; name: string; slug: string; status: CompanyStatus };

/** What signing in answers. `Account` (from /me) adds the role and the companies to switch between. */
export type SignInResult = { user: User; company: CompanySummary };

/** Who is signed in, to which company, in which role, and every company they can switch to. */
export type Account = {
  user: User;
  company: CompanySummary;
  role: Role;
  companies: { id: string; name: string }[];
};

export type StepView = {
  id: string;
  position: number;
  type: StepType;
  approvalClass: ApprovalClass;
  enabled: boolean;
  version: number;
  status: StepStatus;
  preview: StepPreview;
  canApprove: boolean;
  attempts: number;
  result: StepResult | null;
  errorPlain: string | null;
  payload?: Record<string, unknown>;
};

export type TaskView = {
  id: string;
  agent: Agent;
  kind: string;
  title: string;
  summary: string | null;
  status: TaskStatus;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  /** Minutes of staff time the plan saved, set when it finishes; null until then. */
  minutesSaved: number | null;
  rerunOfTaskId: string | null;
  steps: StepView[];
};

export type ApprovalsList = { count: number; tasks: TaskView[] };

export type CompanyBody = {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  legalName: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  timezone: string;
  logoUrl: string | null;
};

export type TeamBody = {
  members: {
    id: string;
    userId: string;
    name: string;
    email: string;
    role: Role;
    canApproveSpend: boolean;
    status: 'active' | 'disabled';
  }[];
  invites: { id: string; email: string; role: Role; expiresAt: string }[];
};

export type SearchResult = {
  customers: { id: string; displayName: string; phone: string | null }[];
  jobs: {
    id: string;
    stage: JobStage;
    stageLabel: string;
    customerId: string;
    customerName: string;
    propertyId: string | null;
    addressLine: string | null;
  }[];
  addresses: {
    id: string;
    addressLine: string;
    city: string | null;
    state: string | null;
    zip: string | null;
    customerId: string;
    customerName: string;
  }[];
};

export type PinsResult =
  | {
      mode: 'points';
      customers: { propertyId: string; customerId: string; lng: number; lat: number; name: string; addressLine: string }[];
      jobs: {
        jobId: string;
        customerId: string;
        propertyId: string;
        stage: JobStage;
        stageLabel: string;
        lng: number;
        lat: number;
        name: string;
        addressLine: string;
      }[];
    }
  | {
      mode: 'clusters';
      clusters: { layer: 'customers' | 'jobs'; lng: number; lat: number; count: number }[];
      total: number;
    };

export type MapArea = {
  serviceArea: { type: 'MultiPolygon'; coordinates: number[][][][] } | null;
  bounds: [number, number, number, number] | null;
};

export type CurrentWeather = {
  tempF: number;
  summary: string;
  icon: 'sun' | 'moon' | 'cloud' | 'rain' | 'storm' | 'snow' | 'fog' | 'wind';
  isDaytime: boolean;
  updatedAt: string;
};

/** A box on the map in degrees: west, south, east, north. The map and the pins query share it. */
export type Bbox = [west: number, south: number, east: number, north: number];
