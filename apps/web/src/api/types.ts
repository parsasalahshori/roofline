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
  /** On for companies with the WinChoice back office (products and pricing, designer, orders). */
  backofficeEnabled?: boolean;
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
  /** The company's one brand colour (#rrggbb), or null for Roofline's default blue. Read-only: the instant quote page's accent colour. */
  brandColor?: string | null;
  located: boolean;
  serviceAreaMiles: number | null;
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
    /** Whether this member gets storm alert emails (S1 Task 27). */
    stormAlertEmail: boolean;
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

/** The storm template texts. */
export type StormTemplates = { smsTemplate: string; emailSubject: string; emailTemplate: string };

/** One ad photo (S1 Task 27). `url` is `/api/storm/photos/:id/file`. */
export type StormPhoto = { id: string; url: string; createdAt: string };

/** GET/PUT /api/storm/settings. The templates are what applies now (the default when none is saved). */
export type StormSettingsBody = StormTemplates & {
  /** Hail size in inches that starts a storm plan: 0.75 to 2 in quarter-inch steps. */
  thresholdIn: number;
  adBudgetCents: number;
  adDays: number;
  adGoogleSharePct: number;
  emailEnabled: boolean;
  defaults: StormTemplates;
  photos: StormPhoto[];
  maxPhotos: number;
};

/** What PUT /api/storm/settings takes: any of these, only what changed. An empty template resets it to the default. */
export type StormSettingsPatch = Partial<
  StormTemplates & { thresholdIn: number; adBudgetCents: number; adDays: number; adGoogleSharePct: number; emailEnabled: boolean }
>;

export type AdPlatform = 'google' | 'meta';
export type AdAccountStatus = 'pending' | 'active' | 'error' | 'revoked';
/** One connected ad account, as the ad API's row. `lastErrorPlain` is our own plain sentence, safe to show; provider text never is. */
export type AdAccount = {
  id: string;
  platform: AdPlatform;
  externalAccountId: string;
  status: AdAccountStatus;
  name: string | null;
  currency: string | null;
  lastErrorPlain: string | null;
  linkedAt: string | null;
};

/** GET /api/ads/accounts. `managerId` is Roofline's Google manager ID, `businessId` its Meta Business ID (null until set up). */
export type AdAccountsBody = { accounts: AdAccount[]; managerId: string | null; businessId: string | null };
