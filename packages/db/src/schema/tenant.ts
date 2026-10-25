import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACTIVITY_ACTOR_TYPES,
  ACTIVITY_SUBJECT_TYPES,
  AGENTS,
  APPROVAL_CLASSES,
  CONSENT_STATUSES,
  CUSTOMER_SOURCES,
  DEFAULT_FRONT_DESK_VOICE,
  DEFAULT_WORK_HOURS,
  FRONT_DESK_VOICES,
  GATE_RULES,
  IMPORT_ROW_OUTCOMES,
  IMPORT_STATUSES,
  JOB_SOURCES,
  JOB_STAGES,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  MESSAGE_PURPOSES,
  MESSAGE_STATUSES,
  SETUP_ITEM_KEYS,
  SETUP_STATUSES,
  SMS_CONSENT_SOURCES,
  STEP_STATUSES,
  TASK_STATUSES,
  PITCH_SOURCES,
  type AddOnUnit,
  type RoofPlane,
  type Roof3dSnapshot,
  type SolarSnapshot,
  type WorkHours,
  WINDOW_DETECTORS,
  WINDOWS_MISS_REASONS,
  type EstimatedWindows,
  type FacadePhoto,
  type LngLat,
  type MeasuredWindow,
  type WindowAdjustments,
  type WindowPhotoUpload,
  type GutterAdjustments,
  WINDOW_ORDER_STATUSES,
  HOMEOWNER_CALLBACK_REASONS,
  SCAN_OUTCOMES,
  SCAN_STATUSES,
  type ScanFrame,
  type ScanMark,
  type ScanResult,
  type ScanWall,
  type ScanHistoryEvent,
  type WindowOrderLine,
  type WindowOrderSettings,
  type WindowCatalog,
  type WindowOrderSettingsPatch,
} from '@roofline/shared';
import { bytea, citext, enumCheck, multiPolygon, pk, point4326, timestamps, tstz } from './columns.ts';
import {
  ACTOR_TYPES,
  AD_ACCOUNT_STATUSES,
  AD_CAMPAIGN_STATUSES,
  AD_PAUSED_BY,
  AD_ERROR_KINDS,
  AD_PLATFORMS,
  AGENT_EVENT_KINDS,
  APPOINTMENT_KINDS,
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUSES,
  CALENDAR_CONNECTION_STATUSES,
  CALENDAR_PROVIDERS,
  CALL_STATUSES,
  CLAIM_EVENT_ACTORS,
  CLAIM_STATUSES,
  CLAIM_TAKEN_BY,
  CONFIRMED_VIA,
  CONSENT_REGIMES,
  CONVERSATION_CHANNELS,
  CONVERSATION_OUTCOMES,
  CONVERSATION_STATUSES,
  COMPANY_STORM_STATUSES,
  DOOR_OUTCOMES,
  DOOR_ROUTE_STATUSES,
  EARLY_DELIVERY_STATUSES,
  EMAIL_OPT_OUT_SOURCES,
  EXACT_ORDER_STATUSES,
  FOLLOW_UP_KINDS,
  HANDLED_BY,
  IDENTITY_LEVELS,
  INTEGRATION_STATUSES,
  MEASUREMENT_KINDS,
  MEASUREMENT_METHODS,
  PROPOSAL_EVENT_KINDS,
  PROPOSAL_STATUSES,
  QUOTE_STATUSES,
  STORED_FILE_KINDS,
  TASK_MODES,
  TIER_MATERIALS,
  TIERS,
  RECORDING_STATUSES,
  TRANSFER_RESULTS,
  TURN_ROUTES,
  TURN_SPEAKERS,
  USAGE_KINDS,
} from './enums.ts';
import { companies, storms, users } from './global.ts';

/*
 * Tenant tables (spec 3.1): every row carries `company_id uuid not null`, and Task 4 turns on
 * row-level security for each table named in TENANT_TABLES.
 */

/** Every table in this file. The RLS migration iterates this list. */
export const TENANT_TABLES = [
  'company_settings',
  'customers',
  'properties',
  'jobs',
  'activities',
  'audit_log',
  'integrations',
  'usage_events',
  'agent_tasks',
  'agent_task_steps',
  'messages',
  'opt_outs',
  'setup_items',
  'imports',
  'import_rows',
  'early_delivery_reports',
  'appointments',
  'calendar_connections',
  'calendar_event_links',
  'calendar_busy_blocks',
  'member_schedules',
  'pricebooks',
  'quotes',
  'quote_counters',
  'measurements',
  'tier_templates',
  'proposals',
  'proposal_counters',
  'proposal_options',
  'proposal_signatures',
  'proposal_events',
  'exact_report_orders',
  'stored_files',
  'conversations',
  'calls',
  'conversation_turns',
  'claim_intakes',
  'blocked_numbers',
  'time_baselines',
  'agent_task_events',
  'agent_settings',
  'time_recounts',
  'claims',
  'claim_events',
  'follow_up_log',
  'company_storms',
  'storm_hits',
  'door_routes',
  'door_stops',
  'door_exclusions',
  'ad_accounts',
  'ad_campaigns',
  'storm_pages',
  'storm_requests',
  'email_opt_outs',
  'storm_photos',
  'window_measurements',
  'quote_estimates',
  'quote_requests',
  'window_orders',
  'homeowner_requests',
  'window_scans',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id);

const userRef = (name: string) => uuid(name).references(() => users.id);

/*
 * Same-company foreign keys. A plain `references(() => customers.id)` would let a company-A row
 * point at a company-B customer: RLS WITH CHECK only looks at the inserting row's own company_id,
 * and Postgres runs foreign-key checks without RLS. So every link between two tenant tables is a
 * composite key `(company_id, x_id) -> (company_id, id)`, which needs `unique (company_id, id)` on
 * the parent. Nullable link columns stay nullable: MATCH SIMPLE skips the check when one is NULL.
 */

export const companySettings = pgTable(
  'company_settings',
  {
    id: pk(),
    companyId: companyId().unique(),
    hourlyRateCents: integer('hourly_rate_cents').notNull().default(2800),
    hailThresholdIn: numeric('hail_threshold_in', { precision: 4, scale: 2, mode: 'number' }).notNull().default(1),
    /** May be lowered but never raised above 2 (spec 3.3). */
    marketingCapPer7d: integer('marketing_cap_per_7d').notNull().default(2),
    financingAprBps: integer('financing_apr_bps'),
    financingTermMonths: integer('financing_term_months'),
    workHours: jsonb('work_hours').$type<WorkHours>().notNull().default(DEFAULT_WORK_HOURS),
    /** Minutes of driving between two appointments; 0 when both are at the same home. */
    travelBufferMinutes: integer('travel_buffer_minutes').notNull().default(30),
    /** The shortest notice a booking may have, in minutes. */
    minNoticeMinutes: integer('min_notice_minutes').notNull().default(120),
    /** Days in stage before a Lead, Inspection or Proposal counts as stuck. */
    stuckAfterDays: integer('stuck_after_days').notNull().default(14),
    /** The pitch assumed when a measurement has no measured pitch, in twelfths (6 = 6/12). */
    defaultPitchX12: numeric('default_pitch_x12', { precision: 4, scale: 2, mode: 'number' }).notNull().default(6),
    /** Roof overhang added to the footprint, in feet. */
    overhangFt: numeric('overhang_ft', { precision: 3, scale: 1, mode: 'number' }).notNull().default(1),
    /** How long a new proposal stays valid, in days. */
    proposalValidDays: integer('proposal_valid_days').notNull().default(30),
    aerialMeasure: boolean('aerial_measure').notNull().default(false),
    /** Whether a signed proposal carries the estimate clause (spec 5.3). */
    estimateChangeClause: boolean('estimate_change_clause').notNull().default(true),
    /** Window factory orders: the company's deductions, rounding, uncertainty factor and limits (null = the defaults in code). */
    windowOrderSettings: jsonb('window_order_settings').$type<WindowOrderSettingsPatch>(),
    /** The window catalog homeowners see: style choices, tier names and prices, adders, included list, trust, offer, financing (null = the defaults in code). */
    windowCatalog: jsonb('window_catalog').$type<WindowCatalog>(),
    /** Front Desk: false until forwarding passes or the owner turns it on. */
    frontDeskEnabled: boolean('front_desk_enabled').notNull().default(false),
    /** Front Desk: text the caller back about a missed call and answer SMS. */
    frontDeskTexts: boolean('front_desk_texts').notNull().default(true),
    /** Seconds the team's phones ring before the assistant answers; 0 turns it off. */
    ringTeamFirstSeconds: integer('ring_team_first_seconds').notNull().default(0),
    frontDeskVoice: text('front_desk_voice').notNull().default(DEFAULT_FRONT_DESK_VOICE),
    /** Facts the assistant may state about the company (hours, areas, services), at most 2,000 characters. */
    frontDeskFacts: text('front_desk_facts').notNull().default(''),
    frontDeskCanMove: boolean('front_desk_can_move').notNull().default(true),
    frontDeskCanCancel: boolean('front_desk_can_cancel').notNull().default(true),
    missedCallTextBack: boolean('missed_call_text_back').notNull().default(true),
    /** Days to keep call recordings; 0 means do not record. */
    recordingRetentionDays: integer('recording_retention_days').notNull().default(90),
    transcriptRetentionDays: integer('transcript_retention_days').notNull().default(365),
    maxConcurrentAiCalls: integer('max_concurrent_ai_calls').notNull().default(4),
    forwardingVerifiedAt: tstz('forwarding_verified_at'),
    /** Days after the claim status changes at which the Claims agent nudges. */
    claimsNudgeDays: integer('claims_nudge_days').array().notNull().default(sql`'{3,5,7}'::integer[]`),
    weatherRainPct: integer('weather_rain_pct').notNull().default(60),
    weatherGustMph: integer('weather_gust_mph').notNull().default(25),
    reminderHour: integer('reminder_hour').notNull().default(15),
    followupDays: integer('followup_days').array().notNull().default(sql`'{3,4}'::integer[]`),
    leadFollowupDays: integer('lead_followup_days').notNull().default(2),
    reviewLink: text('review_link'),
    reviewDelayDays: integer('review_delay_days').notNull().default(3),
    followupReviews: boolean('followup_reviews').notNull().default(true),
    followupLeads: boolean('followup_leads').notNull().default(true),
    followupProposals: boolean('followup_proposals').notNull().default(true),
    /** Storm Scout ad defaults (spec 5): total budget in cents, days to run, and Google's share in percent. */
    stormAdBudgetCents: integer('storm_ad_budget_cents').notNull().default(27000),
    stormAdDays: integer('storm_ad_days').notNull().default(7),
    stormAdGoogleSharePct: integer('storm_ad_google_share_pct').notNull().default(55),
    stormEmailEnabled: boolean('storm_email_enabled').notNull().default(true),
    stormSmsTemplate: text('storm_sms_template'),
    stormEmailSubject: text('storm_email_subject'),
    stormEmailTemplate: text('storm_email_template'),
    /** Instant quote page (public /q/:slug): off until the owner turns it on. */
    quoteEnabled: boolean('quote_enabled').notNull().default(false),
    /** The page's public slug, unique across companies; null until set. */
    quoteSlug: text('quote_slug').unique('company_settings_quote_slug_uniq'),
    /** Products the page offers, a subset of QUOTE_PRODUCTS. */
    quoteProducts: text('quote_products').array().notNull().default(sql`'{windows,roof}'::text[]`),
    /** Range width each side of the middle price, percent. */
    quoteRangePct: integer('quote_range_pct').notNull().default(12),
    /** Fresh (uncached) measurements a day; past it the page offers a call back and still takes the request. */
    quoteDailyCap: integer('quote_daily_cap').notNull().default(50),
    /** Sites allowed to embed the page (frame-ancestors) and call its API from the browser (CORS). */
    quoteEmbedOrigins: text('quote_embed_origins').array().notNull().default(sql`'{}'::text[]`),
    /** Whether the page offers in-home visit times. */
    quoteBooking: boolean('quote_booking').notNull().default(false),
    /** The page's accent colour (#rgb or #rrggbb); null for the default. */
    quoteAccentColor: text('quote_accent_color'),
    ...timestamps(),
  },
  (t) => [
    check('company_settings_quote_slug_check', sql`${t.quoteSlug} ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'`),
    check('company_settings_quote_products_check', sql`${t.quoteProducts} <@ array['windows','roof','gutters']::text[]`),
    check('company_settings_quote_range_pct_check', sql`${t.quoteRangePct} between 5 and 40`),
    check('company_settings_quote_daily_cap_check', sql`${t.quoteDailyCap} between 0 and 1000`),
    check('company_settings_quote_embed_origins_check', sql`cardinality(${t.quoteEmbedOrigins}) <= 10`),
    check('company_settings_quote_accent_color_check', sql`${t.quoteAccentColor} ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'`),
    check('company_settings_storm_ad_budget_cents_check', sql`${t.stormAdBudgetCents} between 0 and 1000000`),
    check('company_settings_storm_ad_days_check', sql`${t.stormAdDays} between 1 and 30`),
    check('company_settings_storm_ad_google_share_pct_check', sql`${t.stormAdGoogleSharePct} between 0 and 100`),
    check('company_settings_marketing_cap_per_7d_check', sql`${t.marketingCapPer7d} between 0 and 2`),
    check('company_settings_travel_buffer_minutes_check', sql`${t.travelBufferMinutes} between 0 and 120`),
    check('company_settings_min_notice_minutes_check', sql`${t.minNoticeMinutes} between 0 and 4320`),
    check('company_settings_stuck_after_days_check', sql`${t.stuckAfterDays} between 3 and 90`),
    check('company_settings_default_pitch_x12_check', sql`${t.defaultPitchX12} between 0 and 24`),
    check('company_settings_overhang_ft_check', sql`${t.overhangFt} between 0 and 3`),
    check('company_settings_proposal_valid_days_check', sql`${t.proposalValidDays} between 1 and 180`),
    check('company_settings_ring_team_first_seconds_check', sql`${t.ringTeamFirstSeconds} between 0 and 30`),
    enumCheck(
      'company_settings',
      'front_desk_voice',
      t.frontDeskVoice,
      FRONT_DESK_VOICES.map((v) => v.id),
    ),
    check('company_settings_front_desk_facts_check', sql`char_length(${t.frontDeskFacts}) <= 2000`),
    check('company_settings_recording_retention_days_check', sql`${t.recordingRetentionDays} between 0 and 365`),
    check('company_settings_transcript_retention_days_check', sql`${t.transcriptRetentionDays} between 30 and 730`),
    check('company_settings_max_concurrent_ai_calls_check', sql`${t.maxConcurrentAiCalls} between 1 and 10`),
    check('company_settings_weather_rain_pct_check', sql`${t.weatherRainPct} between 0 and 100`),
    check('company_settings_weather_gust_mph_check', sql`${t.weatherGustMph} between 1 and 100`),
    check('company_settings_reminder_hour_check', sql`${t.reminderHour} between 0 and 23`),
    check('company_settings_lead_followup_days_check', sql`${t.leadFollowupDays} between 1 and 30`),
    check('company_settings_review_delay_days_check', sql`${t.reviewDelayDays} between 0 and 30`),
  ],
);

/** One entry of `customers.phones`. */
export type CustomerPhone = { e164: string; label?: string; primary?: boolean };

export const customers = pgTable(
  'customers',
  {
    id: pk(),
    companyId: companyId(),
    displayName: text('display_name').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    phones: jsonb('phones').$type<CustomerPhone[]>().notNull().default([]),
    emails: jsonb('emails').$type<string[]>().notNull().default([]),
    smsConsentStatus: text('sms_consent_status', { enum: CONSENT_STATUSES }).notNull().default('none'),
    smsConsentSource: text('sms_consent_source', { enum: SMS_CONSENT_SOURCES }),
    smsConsentAt: tstz('sms_consent_at'),
    smsConsentByUserId: userRef('sms_consent_by_user_id'),
    /** For example the import ID plus the exact confirmation text. */
    smsConsentEvidence: jsonb('sms_consent_evidence').$type<Record<string, unknown>>(),
    doNotContact: boolean('do_not_contact').notNull().default(false),
    source: text('source', { enum: CUSTOMER_SOURCES }).notNull().default('manual'),
    externalRef: text('external_ref'),
    tags: text('tags').array().notNull().default([]),
    /** Null for agent- or import-created records. */
    createdByUserId: userRef('created_by_user_id'),
    archivedAt: tstz('archived_at'),
    ...timestamps(),
  },
  (t) => [
    unique('customers_company_id_id_uniq').on(t.companyId, t.id),
    index('customers_company_idx').on(t.companyId, t.archivedAt),
    index('customers_phones_gin').using('gin', t.phones.op('jsonb_path_ops')),
    index('customers_emails_gin').using('gin', t.emails),
    enumCheck('customers', 'sms_consent_status', t.smsConsentStatus, CONSENT_STATUSES),
    enumCheck('customers', 'sms_consent_source', t.smsConsentSource, SMS_CONSENT_SOURCES),
    enumCheck('customers', 'source', t.source, CUSTOMER_SOURCES),
  ],
);

export const properties = pgTable(
  'properties',
  {
    id: pk(),
    companyId: companyId(),
    /** Nullable: a home in a storm path may have no customer yet. */
    customerId: uuid('customer_id'),
    addressLine: text('address_line').notNull(),
    city: text('city').notNull(),
    state: text('state').notNull(),
    zip: text('zip').notNull(),
    /** Lowercase `address_line|zip` with punctuation removed and whitespace collapsed. */
    addressKey: text('address_key').notNull(),
    /** `[longitude, latitude]`, SRID 4326. */
    geom: point4326('geom'),
    /** Only when given for this address. Null: the send gate uses the company's zone at send time. */
    timezone: text('timezone'),
    geocodeSource: text('geocode_source'),
    geocodeAccuracy: text('geocode_accuracy'),
    /** Filled by Storm Scout and the Estimator. */
    footprintId: text('footprint_id'),
    yearBuilt: integer('year_built'),
    archivedAt: tstz('archived_at'),
    ...timestamps(),
  },
  (t) => [
    unique('properties_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'properties_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    unique('properties_company_address_key_uniq').on(t.companyId, t.addressKey),
    index('properties_geom_gist').using('gist', t.geom),
    index('properties_customer_idx').on(t.customerId),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: pk(),
    companyId: companyId(),
    customerId: uuid('customer_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    stage: text('stage', { enum: JOB_STAGES }).notNull().default('lead'),
    stageChangedAt: tstz('stage_changed_at').notNull().defaultNow(),
    source: text('source', { enum: JOB_SOURCES }).notNull().default('manual'),
    valueCents: integer('value_cents'),
    assignedUserId: userRef('assigned_user_id'),
    createdByUserId: userRef('created_by_user_id'),
    stormId: uuid('storm_id'),
    lostReason: text('lost_reason'),
    /** The next thing to do on the job, typed by a person. */
    nextStep: text('next_step'),
    nextStepOn: date('next_step_on', { mode: 'string' }),
    archivedAt: tstz('archived_at'),
    ...timestamps(),
  },
  (t) => [
    unique('jobs_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'jobs_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    foreignKey({
      name: 'jobs_company_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [properties.companyId, properties.id],
    }),
    index('jobs_company_stage_idx').on(t.companyId, t.stage),
    index('jobs_company_stage_changed_idx').on(t.companyId, t.stage, t.stageChangedAt),
    check('jobs_next_step_check', sql`char_length(${t.nextStep}) <= 120`),
    index('jobs_customer_idx').on(t.customerId),
    index('jobs_property_idx').on(t.propertyId),
    index('jobs_assigned_idx').on(t.assignedUserId),
    enumCheck('jobs', 'stage', t.stage, JOB_STAGES),
    enumCheck('jobs', 'source', t.source, JOB_SOURCES),
  ],
);

/** The timeline for any customer, property or job, and for a message from a number that is no customer's (`subject_type` `message`). */
export const activities = pgTable(
  'activities',
  {
    id: pk(),
    companyId: companyId(),
    subjectType: text('subject_type', { enum: ACTIVITY_SUBJECT_TYPES }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type', { enum: ACTIVITY_ACTOR_TYPES }).notNull(),
    actorUserId: userRef('actor_user_id'),
    actorAgent: text('actor_agent'),
    at: tstz('at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index('activities_subject_idx').on(t.companyId, t.subjectType, t.subjectId, t.at),
    enumCheck('activities', 'subject_type', t.subjectType, ACTIVITY_SUBJECT_TYPES),
    enumCheck('activities', 'actor_type', t.actorType, ACTIVITY_ACTOR_TYPES),
  ],
);

/** Append-only: Task 4 grants INSERT and SELECT but no UPDATE or DELETE. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    companyId: companyId(),
    actorUserId: userRef('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    at: tstz('at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [index('audit_log_company_at_idx').on(t.companyId, t.at)],
);

export const integrations = pgTable(
  'integrations',
  {
    id: pk(),
    companyId: companyId(),
    provider: text('provider').notNull(),
    status: text('status', { enum: INTEGRATION_STATUSES }).notNull().default('connected'),
    /** AES-256-GCM; the master key comes from the secret store. */
    encryptedCredentials: bytea('encrypted_credentials'),
    scopes: text('scopes').array().notNull().default([]),
    connectedByUserId: userRef('connected_by_user_id'),
    connectedAt: tstz('connected_at'),
    lastError: text('last_error'),
    ...timestamps(),
  },
  (t) => [
    unique('integrations_company_provider_uniq').on(t.companyId, t.provider),
    enumCheck('integrations', 'status', t.status, INTEGRATION_STATUSES),
  ],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: pk(),
    companyId: companyId(),
    kind: text('kind', { enum: USAGE_KINDS }).notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 4, mode: 'number' }).notNull(),
    unitCostCents: numeric('unit_cost_cents', { precision: 14, scale: 4, mode: 'number' }),
    refType: text('ref_type'),
    refId: text('ref_id'),
    reportedToStripeAt: tstz('reported_to_stripe_at'),
    description: text('description'),
    meterBatchId: uuid('meter_batch_id'),
    stripeInvoiceItemId: text('stripe_invoice_item_id'),
    at: tstz('at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index('usage_events_company_at_idx').on(t.companyId, t.at),
    /** One charge per (company, kind, ref): a second write of the same reference is ignored. */
    uniqueIndex('usage_events_ref_uniq')
      .on(t.companyId, t.kind, t.refType, t.refId)
      .where(sql`${t.refId} is not null`),
    index('usage_events_unreported_idx')
      .on(t.companyId)
      .where(sql`${t.reportedToStripeAt} is null`),
    enumCheck('usage_events', 'kind', t.kind, USAGE_KINDS),
  ],
);

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: pk(),
    companyId: companyId(),
    agent: text('agent', { enum: AGENTS }).notNull(),
    /** For example `storm_plan`, `proposal_send`, `booking`. */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    /** Optional link to a job, storm or customer. */
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    mode: text('mode', { enum: TASK_MODES }).notNull().default('needs_approval'),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('draft'),
    expiresAt: tstz('expires_at'),
    approvedByUserId: userRef('approved_by_user_id'),
    approvedAt: tstz('approved_at'),
    declinedByUserId: userRef('declined_by_user_id'),
    declinedAt: tstz('declined_at'),
    declineReason: text('decline_reason'),
    /** Set when the task finishes. */
    minutesSaved: numeric('minutes_saved', { precision: 10, scale: 2, mode: 'number' }),
    /**
     * The expired plan this draft was made from by "run again", or null. A plan is run again at most
     * once: the unique index below holds even if two reruns race.
     */
    rerunOfTaskId: uuid('rerun_of_task_id'),
    ...timestamps(),
  },
  (t) => [
    unique('agent_tasks_company_id_id_uniq').on(t.companyId, t.id),
    uniqueIndex('agent_tasks_company_rerun_of_uniq')
      .on(t.companyId, t.rerunOfTaskId)
      .where(sql`${t.rerunOfTaskId} is not null`),
    index('agent_tasks_company_status_idx').on(t.companyId, t.status, t.createdAt),
    index('agent_tasks_status_expires_idx').on(t.status, t.expiresAt),
    enumCheck('agent_tasks', 'agent', t.agent, AGENTS),
    enumCheck('agent_tasks', 'mode', t.mode, TASK_MODES),
    enumCheck('agent_tasks', 'status', t.status, TASK_STATUSES),
  ],
);

export const agentTaskSteps = pgTable(
  'agent_task_steps',
  {
    id: pk(),
    companyId: companyId(),
    taskId: uuid('task_id').notNull(),
    position: integer('position').notNull(),
    /** For example `send_sms_batch`, `send_proposal`, `build_routes`. */
    type: text('type').notNull(),
    /** Set by the step type's definition, never by the agent. */
    approvalClass: text('approval_class', { enum: APPROVAL_CLASSES }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Goes up on every edit; used for the optimistic check. */
    version: integer('version').notNull().default(1),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** What the review screen shows. */
    preview: jsonb('preview').$type<Record<string, unknown>>().notNull().default({}),
    editedByUserId: userRef('edited_by_user_id'),
    editedAt: tstz('edited_at'),
    approvedByUserId: userRef('approved_by_user_id'),
    approvedAt: tstz('approved_at'),
    status: text('status', { enum: STEP_STATUSES }).notNull().default('pending'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** A reason a person can read. */
    errorPlain: text('error_plain'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * Until when the run that claimed this step owns it: set by the claim, cleared when that run
     * ends. A `running` step with no lease is parked (it finishes by itself later, such as texts
     * waiting out quiet hours); one whose lease has passed was left behind by a run that died, and
     * the sweeper puts it back in the queue.
     */
    leaseExpiresAt: tstz('lease_expires_at'),
    /**
     * Which run owns the step: every claim takes the next number, and a run saves its outcome only
     * while the step is `running` at its own number. Nothing ever lowers it (a person's retry puts
     * `attempts` back to 0 but leaves this alone), so a run that outlived its lease can never be
     * mistaken for a newer one.
     */
    runSeq: integer('run_seq').notNull().default(0),
    /** Set when the step is done: the snapshot every time-saved number comes from. */
    baselineKey: text('baseline_key'),
    units: numeric('units', { precision: 10, scale: 2, mode: 'number' }),
    minutesPerUnit: numeric('minutes_per_unit', { precision: 6, scale: 2, mode: 'number' }),
    minutesSaved: numeric('minutes_saved', { precision: 10, scale: 2, mode: 'number' }),
    ...timestamps(),
  },
  (t) => [
    unique('agent_task_steps_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'agent_task_steps_company_task_fk',
      columns: [t.companyId, t.taskId],
      foreignColumns: [agentTasks.companyId, agentTasks.id],
    }),
    unique('agent_task_steps_task_position_uniq').on(t.taskId, t.position),
    index('agent_task_steps_status_idx').on(t.status, t.updatedAt),
    enumCheck('agent_task_steps', 'approval_class', t.approvalClass, APPROVAL_CLASSES),
    enumCheck('agent_task_steps', 'status', t.status, STEP_STATUSES),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: pk(),
    companyId: companyId(),
    /** Nullable: inbound texts from unknown numbers have no customer. */
    customerId: uuid('customer_id'),
    channel: text('channel', { enum: MESSAGE_CHANNELS }).notNull(),
    direction: text('direction', { enum: MESSAGE_DIRECTIONS }).notNull(),
    purpose: text('purpose', { enum: MESSAGE_PURPOSES }),
    body: text('body').notNull(),
    status: text('status', { enum: MESSAGE_STATUSES }).notNull(),
    blockRule: text('block_rule', { enum: GATE_RULES }),
    blockReason: text('block_reason'),
    scheduledFor: tstz('scheduled_for'),
    sentAt: tstz('sent_at'),
    providerMessageSid: text('provider_message_sid'),
    stepId: uuid('step_id'),
    dedupeKey: text('dedupe_key'),
    segments: integer('segments').notNull().default(1),
    /** Outbound: the customer's number. Inbound: the company's texting number it was sent to. */
    toE164: text('to_e164'),
    /** Inbound only: the number the text came from. Null on outbound rows. */
    fromE164: text('from_e164'),
    /**
     * For a `failed` text: whether trying again is safe. True only when the provider refused it
     * (so it never went out); false when it may have gone out (unconfirmed) or can never go out.
     */
    retryable: boolean('retryable').notNull().default(false),
    /** Front Desk: the conversation a text belongs to (null for texts outside Front Desk). */
    conversationId: uuid('conversation_id'),
    /** Email rows: the recipient address. Null on texts. */
    toEmail: citext('to_email'),
    /** Email rows: the subject line. */
    subject: text('subject'),
    ...timestamps(),
  },
  (t) => [
    unique('messages_company_id_id_uniq').on(t.companyId, t.id),
    check('messages_email_to_email_check', sql`${t.channel} <> 'email' OR ${t.toEmail} IS NOT NULL`),
    foreignKey({
      name: 'messages_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    foreignKey({
      name: 'messages_company_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversations.companyId, conversations.id],
    }),
    foreignKey({
      name: 'messages_company_step_fk',
      columns: [t.companyId, t.stepId],
      foreignColumns: [agentTaskSteps.companyId, agentTaskSteps.id],
    }),
    /** A step texts each customer at most once, which makes batch retries safe. */
    uniqueIndex('messages_step_customer_uniq')
      .on(t.stepId, t.customerId)
      .where(sql`${t.stepId} is not null`),
    index('messages_customer_idx').on(t.companyId, t.customerId, t.createdAt),
    index('messages_dedupe_idx').on(t.companyId, t.dedupeKey),
    /** The inbox detail reads a conversation's texts in time order. */
    index('messages_company_conversation_created_idx').on(t.companyId, t.conversationId, t.createdAt),
    /** A Front Desk text is recorded once per dedupe key (`fd-text:`, `fd-book:`, `fd-textback:`, `fd-reply:`): a race inserts once. */
    uniqueIndex('messages_fd_dedupe_uniq')
      .on(t.companyId, t.dedupeKey)
      .where(sql`${t.dedupeKey} like 'fd-%'`),
    index('messages_status_scheduled_idx').on(t.status, t.scheduledFor),
    index('messages_provider_sid_idx').on(t.providerMessageSid),
    /** A provider delivers an inbound text once per SID: a repeat for the same company is a duplicate. */
    uniqueIndex('messages_inbound_sid_uniq')
      .on(t.companyId, t.providerMessageSid)
      .where(sql`${t.direction} = 'in'`),
    enumCheck('messages', 'channel', t.channel, MESSAGE_CHANNELS),
    enumCheck('messages', 'direction', t.direction, MESSAGE_DIRECTIONS),
    enumCheck('messages', 'purpose', t.purpose, MESSAGE_PURPOSES),
    enumCheck('messages', 'status', t.status, MESSAGE_STATUSES),
    enumCheck('messages', 'block_rule', t.blockRule, GATE_RULES),
  ],
);

export const optOuts = pgTable(
  'opt_outs',
  {
    id: pk(),
    companyId: companyId(),
    phoneE164: text('phone_e164').notNull(),
    keyword: text('keyword'),
    at: tstz('at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [unique('opt_outs_company_phone_uniq').on(t.companyId, t.phoneE164)],
);

/** The setup checklist: one row per company and item (F3 spec 5.3). */
export const setupItems = pgTable(
  'setup_items',
  {
    id: pk(),
    companyId: companyId(),
    key: text('key', { enum: SETUP_ITEM_KEYS }).notNull(),
    status: text('status', { enum: SETUP_STATUSES }).notNull().default('todo'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    unique('setup_items_company_key_uniq').on(t.companyId, t.key),
    enumCheck('setup_items', 'key', t.key, SETUP_ITEM_KEYS),
    enumCheck('setup_items', 'status', t.status, SETUP_STATUSES),
  ],
);

/** One CSV import: the file, the column mapping and the consent the upload was made under. */
export const imports = pgTable(
  'imports',
  {
    id: pk(),
    companyId: companyId(),
    fileName: text('file_name').notNull(),
    headers: jsonb('headers').$type<string[]>().notNull().default([]),
    mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull().default({}),
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    rowCount: integer('row_count').notNull().default(0),
    consentAttested: boolean('consent_attested').notNull().default(false),
    consentText: text('consent_text'),
    attestedByUserId: userRef('attested_by_user_id'),
    attestedAt: tstz('attested_at'),
    status: text('status', { enum: IMPORT_STATUSES }).notNull().default('uploaded'),
    errorFileUrl: text('error_file_url'),
    errorPlain: text('error_plain'),
    createdByUserId: userRef('created_by_user_id'),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    ...timestamps(),
  },
  (t) => [
    unique('imports_company_id_id_uniq').on(t.companyId, t.id),
    index('imports_company_created_idx').on(t.companyId, t.createdAt),
    enumCheck('imports', 'status', t.status, IMPORT_STATUSES),
  ],
);

/** One CSV row of an import, with what happened to it. */
export const importRows = pgTable(
  'import_rows',
  {
    id: pk(),
    companyId: companyId(),
    importId: uuid('import_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    cells: jsonb('cells').$type<string[]>().notNull(),
    outcome: text('outcome', { enum: IMPORT_ROW_OUTCOMES }),
    reason: text('reason'),
    customerId: uuid('customer_id'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'import_rows_company_import_fk',
      columns: [t.companyId, t.importId],
      foreignColumns: [imports.companyId, imports.id],
    }),
    foreignKey({
      name: 'import_rows_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    unique('import_rows_import_row_uniq').on(t.importId, t.rowNumber),
    index('import_rows_import_outcome_idx').on(t.importId, t.outcome),
    enumCheck('import_rows', 'outcome', t.outcome, IMPORT_ROW_OUTCOMES),
  ],
);

/** A delivery report that arrived before its message was marked sent (applied once the send lands). */
export const earlyDeliveryReports = pgTable(
  'early_delivery_reports',
  {
    id: pk(),
    companyId: companyId(),
    providerMessageSid: text('provider_message_sid').notNull(),
    status: text('status', { enum: EARLY_DELIVERY_STATUSES }).notNull(),
    reason: text('reason'),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    appliedAt: tstz('applied_at'),
    ...timestamps(),
  },
  (t) => [
    unique('early_delivery_reports_company_sid_status_uniq').on(t.companyId, t.providerMessageSid, t.status),
    enumCheck('early_delivery_reports', 'status', t.status, EARLY_DELIVERY_STATUSES),
  ],
);

/** A booked visit (inspection, install, adjuster, other). Times are instants; days use the company zone. */
export const appointments = pgTable(
  'appointments',
  {
    id: pk(),
    companyId: companyId(),
    kind: text('kind', { enum: APPOINTMENT_KINDS }).notNull(),
    title: text('title'),
    /** Nullable: an appointment can stand alone. Same-company keys, see the note above. */
    jobId: uuid('job_id'),
    customerId: uuid('customer_id'),
    propertyId: uuid('property_id'),
    assignedUserId: userRef('assigned_user_id'),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    allDay: boolean('all_day').notNull().default(false),
    status: text('status', { enum: APPOINTMENT_STATUSES }).notNull().default('scheduled'),
    notes: text('notes'),
    source: text('source', { enum: APPOINTMENT_SOURCES }).notNull().default('manual'),
    createdByUserId: userRef('created_by_user_id'),
    canceledAt: tstz('canceled_at'),
    archivedAt: tstz('archived_at'),
    /** When the customer confirmed the visit, and how (a call, a text, or a person marking it). */
    confirmedAt: tstz('confirmed_at'),
    confirmedVia: text('confirmed_via', { enum: CONFIRMED_VIA }),
    /** Set when the Scheduler agent moved this visit; the agent task that did it. */
    movedByTaskId: uuid('moved_by_task_id'),
    ...timestamps(),
  },
  (t) => [
    unique('appointments_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'appointments_company_job_fk',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'appointments_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    foreignKey({
      name: 'appointments_company_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [properties.companyId, properties.id],
    }),
    foreignKey({
      name: 'appointments_company_moved_by_task_fk',
      columns: [t.companyId, t.movedByTaskId],
      foreignColumns: [agentTasks.companyId, agentTasks.id],
    }),
    index('appointments_company_starts_idx').on(t.companyId, t.startsAt),
    index('appointments_company_assignee_starts_idx').on(t.companyId, t.assignedUserId, t.startsAt),
    index('appointments_job_idx').on(t.jobId),
    check('appointments_ends_after_starts_check', sql`${t.endsAt} > ${t.startsAt}`),
    enumCheck('appointments', 'kind', t.kind, APPOINTMENT_KINDS),
    enumCheck('appointments', 'status', t.status, APPOINTMENT_STATUSES),
    enumCheck('appointments', 'source', t.source, APPOINTMENT_SOURCES),
    enumCheck('appointments', 'confirmed_via', t.confirmedVia, CONFIRMED_VIA),
  ],
);

/** One calendar account per person and company (Google or Microsoft). Credentials are encrypted. */
export const calendarConnections = pgTable(
  'calendar_connections',
  {
    id: pk(),
    companyId: companyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: text('provider', { enum: CALENDAR_PROVIDERS }).notNull(),
    accountEmail: text('account_email'),
    calendarId: text('calendar_id'),
    calendarName: text('calendar_name'),
    /** `encrypt(JSON.stringify({ refreshToken }), ENCRYPTION_KEY)`; never logged. */
    encryptedCredentials: bytea('encrypted_credentials').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    status: text('status', { enum: CALENDAR_CONNECTION_STATUSES }).notNull().default('connected'),
    /** A reason key a person can read (for example `reconnect`), never a provider message. */
    lastErrorPlain: text('last_error_plain'),
    syncCursor: text('sync_cursor'),
    lastSyncedAt: tstz('last_synced_at'),
    ...timestamps(),
  },
  (t) => [
    unique('calendar_connections_company_user_uniq').on(t.companyId, t.userId),
    unique('calendar_connections_company_id_id_uniq').on(t.companyId, t.id),
    enumCheck('calendar_connections', 'provider', t.provider, CALENDAR_PROVIDERS),
    enumCheck('calendar_connections', 'status', t.status, CALENDAR_CONNECTION_STATUSES),
  ],
);

/** The link between one appointment and its event on one connected calendar. */
export const calendarEventLinks = pgTable(
  'calendar_event_links',
  {
    id: pk(),
    companyId: companyId(),
    appointmentId: uuid('appointment_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    etag: text('etag'),
    lastPushedAt: tstz('last_pushed_at'),
    /** A reason key (`reconnect`, `unavailable`), never a provider message. */
    pushErrorPlain: text('push_error_plain'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'calendar_event_links_company_appointment_fk',
      columns: [t.companyId, t.appointmentId],
      foreignColumns: [appointments.companyId, appointments.id],
    }),
    foreignKey({
      name: 'calendar_event_links_company_connection_fk',
      columns: [t.companyId, t.connectionId],
      foreignColumns: [calendarConnections.companyId, calendarConnections.id],
    }).onDelete('cascade'),
    unique('calendar_event_links_appointment_uniq').on(t.appointmentId),
    unique('calendar_event_links_connection_event_uniq').on(t.connectionId, t.providerEventId),
  ],
);

/** Busy time from someone's outside calendar: times only, never titles, attendees or locations. */
export const calendarBusyBlocks = pgTable(
  'calendar_busy_blocks',
  {
    id: pk(),
    companyId: companyId(),
    connectionId: uuid('connection_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    providerEventId: text('provider_event_id').notNull(),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    allDay: boolean('all_day').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'calendar_busy_blocks_company_connection_fk',
      columns: [t.companyId, t.connectionId],
      foreignColumns: [calendarConnections.companyId, calendarConnections.id],
    }).onDelete('cascade'),
    unique('calendar_busy_blocks_connection_event_uniq').on(t.connectionId, t.providerEventId),
    index('calendar_busy_blocks_company_user_starts_idx').on(t.companyId, t.userId, t.startsAt),
    check('calendar_busy_blocks_ends_after_starts_check', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

/** A person's weekly working hours, when it differs from the company default. */
export const memberSchedules = pgTable(
  'member_schedules',
  {
    id: pk(),
    companyId: companyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    weeklyHours: jsonb('weekly_hours').$type<WorkHours>().notNull(),
    ...timestamps(),
  },
  (t) => [unique('member_schedules_company_user_uniq').on(t.companyId, t.userId)],
);

/** The company's price list (v1 shape, see `pricebookSchema` in @roofline/shared). One per company. */
export const pricebooks = pgTable('pricebooks', {
  id: pk(),
  companyId: companyId().unique(),
  prices: jsonb('prices').$type<Record<string, unknown>>().notNull(),
  defaults: jsonb('defaults').$type<Record<string, unknown>>().notNull().default({}),
  updatedByUserId: userRef('updated_by_user_id'),
  ...timestamps(),
});

/** A quote for a job. Final quotes are frozen: their stored numbers never reprice. */
export const quotes = pgTable(
  'quotes',
  {
    id: pk(),
    companyId: companyId(),
    jobId: uuid('job_id').notNull(),
    /** `Q-0001` style, unique per company. */
    number: text('number').notNull(),
    status: text('status', { enum: QUOTE_STATUSES }).notNull().default('draft'),
    measurement: jsonb('measurement').$type<Record<string, unknown>>().notNull(),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull(),
    prices: jsonb('prices').$type<Record<string, unknown>>().notNull(),
    calculation: jsonb('calculation').$type<Record<string, unknown>>().notNull(),
    notes: text('notes'),
    validUntil: date('valid_until', { mode: 'string' }).notNull(),
    createdByUserId: userRef('created_by_user_id'),
    finalizedAt: tstz('finalized_at'),
    ...timestamps(),
  },
  (t) => [
    unique('quotes_company_id_id_uniq').on(t.companyId, t.id),
    unique('quotes_company_number_uniq').on(t.companyId, t.number),
    foreignKey({
      name: 'quotes_company_job_fk',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    index('quotes_job_idx').on(t.jobId),
    enumCheck('quotes', 'status', t.status, QUOTE_STATUSES),
  ],
);

/** The next quote number for a company (one row per company). */
export const quoteCounters = pgTable('quote_counters', {
  id: pk(),
  companyId: companyId().unique(),
  nextNumber: integer('next_number').notNull().default(1),
  ...timestamps(),
});

/*
 * E1 estimator tables (spec 3.4, 4.1, 4.3, 5.3, 8). Every link to another tenant table is a
 * same-company composite key, as above.
 */

/** One add-on line of a tier template or a frozen proposal option (spec 4.1). */
export type TierAddOn = { name: string; unit: AddOnUnit; rateCents: number; taxable: boolean };

/** A measured (or manual) roof for a property; immutable once a proposal is sent from it (Decision 8). */
export const measurements = pgTable(
  'measurements',
  {
    id: pk(),
    companyId: companyId(),
    propertyId: uuid('property_id').notNull(),
    jobId: uuid('job_id'),
    kind: text('kind', { enum: MEASUREMENT_KINDS }).notNull(),
    method: text('method', { enum: MEASUREMENT_METHODS }).notNull(),
    /** Null for a manual measurement. `[longitude, latitude]` rings, SRID 4326. */
    outline: multiPolygon('outline'),
    /** Which footprints make up the roof, and which are included. */
    structures: jsonb('structures').$type<Record<string, unknown>[]>().notNull().default([]),
    footprintSqFt: numeric('footprint_sq_ft', { precision: 12, scale: 2, mode: 'number' }),
    overhangFt: numeric('overhang_ft', { precision: 4, scale: 2, mode: 'number' }),
    pitchX12: numeric('pitch_x12', { precision: 4, scale: 2, mode: 'number' }),
    surfaceSqFt: numeric('surface_sq_ft', { precision: 12, scale: 2, mode: 'number' }),
    edgeFt: numeric('edge_ft', { precision: 12, scale: 2, mode: 'number' }),
    /** An exact report's eave length (EagleView LengthEave), ft: the gutter total for that measurement. Null otherwise. */
    eaveFt: numeric('eave_ft', { precision: 12, scale: 2, mode: 'number' }),
    ridgeFt: numeric('ridge_ft', { precision: 12, scale: 2, mode: 'number' }),
    valleyFt: numeric('valley_ft', { precision: 12, scale: 2, mode: 'number' }),
    facets: integer('facets'),
    providerRef: text('provider_ref'),
    notes: text('notes'),
    /** Where pitch_x12 came from: Google Solar, the estimator's default, or a person. Null on older rows. */
    pitchSource: text('pitch_source', { enum: PITCH_SOURCES }),
    /** Google Solar's roof planes the facets take their own pitch from (while pitch_source is 'solar'). */
    pitchPlanes: jsonb('pitch_planes').$type<RoofPlane[]>(),
    /** The Google Solar answer this measurement used (the building, or none there), reused when the home is measured again. */
    solar: jsonb('solar').$type<SolarSnapshot>(),
    /**
     * Roof facet ids ('A', 'B', ...) left out of the quote; empty when the whole roof is quoted. The stored surface,
     * edge, ridge, valley and footprint are then the other facets' only (`facets` stays the whole roof's count).
     */
    excludedFacets: jsonb('excluded_facets').$type<string[]>().notNull().default([]),
    /**
     * The roof reconstructed in 3D from Google Solar's height map (Data Layers, a paid lookup), or why there is none,
     * kept so measuring the home again within 30 days does not buy it again. With a reconstruction, the outline is
     * its real outline and the roof drawn is its faces and lines.
     */
    roof3d: jsonb('roof_3d').$type<Roof3dSnapshot>(),
    /**
     * When the Google content this row holds (the Solar answer in `solar`, the roof photo named by `roof_3d`) must be
     * gone: its download + 30 days (measurementGoogleDeleteBy). The google-retention job clears that content then and
     * sets this to null; our own numbers (outline, faces, pitch, totals) stay. Null: nothing of Google's to delete.
     */
    googleDeleteBy: tstz('google_delete_by'),
    /**
     * Measure gutters: runs left out, downspouts typed in per run, a size chosen by hand, runs added by hand, a typed
     * total and who changed them (see GutterAdjustments). Older rows lack the later keys; repos/gutters.ts reads them
     * tolerantly.
     */
    gutterAdjustments: jsonb('gutter_adjustments')
      .$type<Pick<GutterAdjustments, 'excludedRunIds' | 'downspouts' | 'size'> & Partial<GutterAdjustments>>()
      .notNull()
      .default({ excludedRunIds: [], downspouts: {}, size: null }),
    createdByUserId: userRef('created_by_user_id'),
    ...timestamps(),
  },
  (t) => [
    unique('measurements_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'measurements_company_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [properties.companyId, properties.id],
    }),
    foreignKey({
      name: 'measurements_company_job_fk',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    index('measurements_property_idx').on(t.propertyId),
    index('measurements_google_delete_by_idx').on(t.googleDeleteBy),
    enumCheck('measurements', 'kind', t.kind, MEASUREMENT_KINDS),
    enumCheck('measurements', 'method', t.method, MEASUREMENT_METHODS),
    enumCheck('measurements', 'pitch_source', t.pitchSource, PITCH_SOURCES),
  ],
);

/** The three tier templates of a company (one per tier), the defaults of spec 4.1 until edited. */
export const tierTemplates = pgTable(
  'tier_templates',
  {
    id: pk(),
    companyId: companyId(),
    tier: text('tier', { enum: TIERS }).notNull(),
    /** Shown to the homeowner, for example "Good: Architectural shingles". */
    name: text('name').notNull(),
    material: text('material', { enum: TIER_MATERIALS }).notNull(),
    wastePercent: numeric('waste_percent', { precision: 5, scale: 2, mode: 'number' }).notNull().default(12),
    /** Null: the company's pricebook default applies. */
    markupPercent: numeric('markup_percent', { precision: 5, scale: 2, mode: 'number' }),
    addOns: jsonb('add_ons').$type<TierAddOn[]>().notNull().default([]),
    /** Up to four short bullets for the homeowner. */
    highlights: text('highlights').array().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('tier_templates_company_id_id_uniq').on(t.companyId, t.id),
    unique('tier_templates_company_tier_uniq').on(t.companyId, t.tier),
    check('tier_templates_highlights_check', sql`cardinality(${t.highlights}) <= 4`),
    enumCheck('tier_templates', 'tier', t.tier, TIERS),
    enumCheck('tier_templates', 'material', t.material, TIER_MATERIALS),
  ],
);

/** A proposal for a job, built from one measurement. Sent proposals never re-price (Decision 11). */
export const proposals = pgTable(
  'proposals',
  {
    id: pk(),
    companyId: companyId(),
    jobId: uuid('job_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    measurementId: uuid('measurement_id').notNull(),
    /** `P-0001` style, unique per company. */
    number: text('number').notNull(),
    status: text('status', { enum: PROPOSAL_STATUSES }).notNull().default('draft'),
    validUntil: date('valid_until', { mode: 'string' }).notNull(),
    /** SHA-256 of the link token. Unique across all companies, so a token maps to one proposal. */
    linkTokenHash: bytea('link_token_hash').notNull(),
    /** Encrypted link token, so the same link can be sent again. */
    linkTokenEncrypted: bytea('link_token_encrypted').notNull(),
    sentAt: tstz('sent_at'),
    firstViewedAt: tstz('first_viewed_at'),
    lastViewedAt: tstz('last_viewed_at'),
    viewCount: integer('view_count').notNull().default(0),
    signedAt: tstz('signed_at'),
    declinedAt: tstz('declined_at'),
    declineReason: text('decline_reason'),
    /** Set when a revised draft replaces a sent proposal (Decision 11). */
    replacedById: uuid('replaced_by_id'),
    /** The text as sent. */
    messageBody: text('message_body'),
    estimateBasis: text('estimate_basis', { enum: MEASUREMENT_KINDS }).notNull(),
    createdByUserId: userRef('created_by_user_id'),
    ...timestamps(),
  },
  (t) => [
    unique('proposals_company_id_id_uniq').on(t.companyId, t.id),
    unique('proposals_company_number_uniq').on(t.companyId, t.number),
    unique('proposals_link_token_hash_uniq').on(t.linkTokenHash),
    foreignKey({
      name: 'proposals_company_job_fk',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'proposals_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    foreignKey({
      name: 'proposals_company_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [properties.companyId, properties.id],
    }),
    foreignKey({
      name: 'proposals_company_measurement_fk',
      columns: [t.companyId, t.measurementId],
      foreignColumns: [measurements.companyId, measurements.id],
    }),
    foreignKey({
      name: 'proposals_company_replaced_by_fk',
      columns: [t.companyId, t.replacedById],
      foreignColumns: [t.companyId, t.id],
    }),
    index('proposals_job_idx').on(t.jobId),
    index('proposals_status_idx').on(t.status),
    enumCheck('proposals', 'status', t.status, PROPOSAL_STATUSES),
    enumCheck('proposals', 'estimate_basis', t.estimateBasis, MEASUREMENT_KINDS),
  ],
);

/** The next proposal number for a company (one row per company). */
export const proposalCounters = pgTable('proposal_counters', {
  id: pk(),
  companyId: companyId().unique(),
  nextNumber: integer('next_number').notNull().default(1),
  ...timestamps(),
});

/** One priced option (good, better or best) of a proposal. `calculation` and `total_cents` are frozen. */
export const proposalOptions = pgTable(
  'proposal_options',
  {
    id: pk(),
    companyId: companyId(),
    proposalId: uuid('proposal_id').notNull(),
    tier: text('tier', { enum: TIERS }).notNull(),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    highlights: text('highlights').array().notNull().default([]),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull(),
    prices: jsonb('prices').$type<Record<string, unknown>>().notNull(),
    addOns: jsonb('add_ons').$type<TierAddOn[]>().notNull(),
    calculation: jsonb('calculation').$type<Record<string, unknown>>().notNull(),
    totalCents: integer('total_cents').notNull(),
    monthlyEstimateCents: integer('monthly_estimate_cents'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('proposal_options_company_id_id_uniq').on(t.companyId, t.id),
    unique('proposal_options_proposal_tier_uniq').on(t.proposalId, t.tier),
    foreignKey({
      name: 'proposal_options_company_proposal_fk',
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
    enumCheck('proposal_options', 'tier', t.tier, TIERS),
  ],
);

/** A PDF or other file in object storage; the bytes are never in the database. */
export const storedFiles = pgTable(
  'stored_files',
  {
    id: pk(),
    companyId: companyId(),
    kind: text('kind', { enum: STORED_FILE_KINDS }).notNull(),
    objectKey: text('object_key').notNull(),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    contentType: text('content_type').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('stored_files_company_id_id_uniq').on(t.companyId, t.id),
    enumCheck('stored_files', 'kind', t.kind, STORED_FILE_KINDS),
  ],
);

/** The signature record of a signed proposal (spec 5.3). At most one per proposal. */
export const proposalSignatures = pgTable(
  'proposal_signatures',
  {
    id: pk(),
    companyId: companyId(),
    proposalId: uuid('proposal_id').notNull(),
    optionId: uuid('option_id').notNull(),
    signerName: text('signer_name').notNull(),
    typedSignature: text('typed_signature').notNull(),
    /** The drawn image itself goes into the signed PDF, not this table. */
    drawnSignaturePngSha256: text('drawn_signature_png_sha256'),
    consentText: text('consent_text').notNull(),
    consentVersion: text('consent_version').notNull(),
    /** SHA-256 of the canonical JSON of the proposal and the chosen option as shown. */
    documentSha256: text('document_sha256').notNull(),
    totalCents: integer('total_cents').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    signedAt: tstz('signed_at').notNull(),
    viewedFirstAt: tstz('viewed_first_at'),
    pdfFileId: uuid('pdf_file_id'),
    pdfSha256: text('pdf_sha256'),
    ...timestamps(),
  },
  (t) => [
    unique('proposal_signatures_company_id_id_uniq').on(t.companyId, t.id),
    unique('proposal_signatures_proposal_uniq').on(t.proposalId),
    foreignKey({
      name: 'proposal_signatures_company_proposal_fk',
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
    foreignKey({
      name: 'proposal_signatures_company_option_fk',
      columns: [t.companyId, t.optionId],
      foreignColumns: [proposalOptions.companyId, proposalOptions.id],
    }),
    foreignKey({
      name: 'proposal_signatures_company_pdf_fk',
      columns: [t.companyId, t.pdfFileId],
      foreignColumns: [storedFiles.companyId, storedFiles.id],
    }),
  ],
);

/** The homeowner side of a proposal's timeline (mirrored as job activities). */
export const proposalEvents = pgTable(
  'proposal_events',
  {
    id: pk(),
    companyId: companyId(),
    proposalId: uuid('proposal_id').notNull(),
    kind: text('kind', { enum: PROPOSAL_EVENT_KINDS }).notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    at: tstz('at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    unique('proposal_events_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'proposal_events_company_proposal_fk',
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
    index('proposal_events_proposal_at_idx').on(t.proposalId, t.at),
    enumCheck('proposal_events', 'kind', t.kind, PROPOSAL_EVENT_KINDS),
  ],
);

/** An EagleView exact-report order for a measurement. Provider text is never stored here (error_plain is ours). */
export const exactReportOrders = pgTable(
  'exact_report_orders',
  {
    id: pk(),
    companyId: companyId(),
    measurementId: uuid('measurement_id').notNull(),
    status: text('status', { enum: EXACT_ORDER_STATUSES }).notNull().default('priced'),
    priceMinCents: integer('price_min_cents'),
    priceMaxCents: integer('price_max_cents'),
    priceExpiresAt: tstz('price_expires_at'),
    providerProductId: text('provider_product_id'),
    providerReportId: text('provider_report_id'),
    referenceId: text('reference_id').notNull(),
    taskId: uuid('task_id'),
    lastPolledAt: tstz('last_polled_at'),
    errorPlain: text('error_plain'),
    ...timestamps(),
  },
  (t) => [
    unique('exact_report_orders_company_id_id_uniq').on(t.companyId, t.id),
    unique('exact_report_orders_company_reference_uniq').on(t.companyId, t.referenceId),
    foreignKey({
      name: 'exact_report_orders_company_measurement_fk',
      columns: [t.companyId, t.measurementId],
      foreignColumns: [measurements.companyId, measurements.id],
    }),
    foreignKey({
      name: 'exact_report_orders_company_task_fk',
      columns: [t.companyId, t.taskId],
      foreignColumns: [agentTasks.companyId, agentTasks.id],
    }),
    enumCheck('exact_report_orders', 'status', t.status, EXACT_ORDER_STATUSES),
  ],
);

/*
 * Front Desk (D1). A conversation is one thread with one other party: a phone call or the SMS
 * thread with one number. The transcript (`conversation_turns`) is shared by both channels.
 */

export type ToolCallRecord = { name: string; input: unknown; result: string; ok: boolean };

export const conversations = pgTable(
  'conversations',
  {
    id: pk(),
    companyId: companyId(),
    channel: text('channel', { enum: CONVERSATION_CHANNELS }).notNull(),
    customerId: uuid('customer_id'),
    /** The other party's number (the caller, or the customer texting in). */
    phoneE164: text('phone_e164').notNull(),
    /** The company number the contact used. */
    companyNumberE164: text('company_number_e164').notNull(),
    status: text('status', { enum: CONVERSATION_STATUSES }).notNull().default('active'),
    handledBy: text('handled_by', { enum: HANDLED_BY }).notNull().default('assistant'),
    /** When a person took over; the assistant may answer again after this. */
    teamUntil: tstz('team_until'),
    lastMessageAt: tstz('last_message_at').notNull().defaultNow(),
    unreadCount: integer('unread_count').notNull().default(0),
    summary: text('summary'),
    outcome: text('outcome', { enum: CONVERSATION_OUTCOMES }),
    identity: text('identity', { enum: IDENTITY_LEVELS }).notNull().default('unknown'),
    ...timestamps(),
  },
  (t) => [
    unique('conversations_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'conversations_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    index('conversations_company_last_message_idx').on(t.companyId, t.lastMessageAt.desc()),
    index('conversations_company_customer_idx').on(t.companyId, t.customerId),
    /** One open SMS thread per company number and contact. */
    uniqueIndex('conversations_active_sms_uniq')
      .on(t.companyId, t.phoneE164)
      .where(sql`${t.channel} = 'sms' and ${t.status} = 'active'`),
    enumCheck('conversations', 'channel', t.channel, CONVERSATION_CHANNELS),
    enumCheck('conversations', 'status', t.status, CONVERSATION_STATUSES),
    enumCheck('conversations', 'handled_by', t.handledBy, HANDLED_BY),
    enumCheck('conversations', 'outcome', t.outcome, CONVERSATION_OUTCOMES),
    enumCheck('conversations', 'identity', t.identity, IDENTITY_LEVELS),
  ],
);

export const calls = pgTable(
  'calls',
  {
    id: pk(),
    companyId: companyId(),
    conversationId: uuid('conversation_id'),
    /** The provider's call id. Unique across companies: one call is one row. */
    callSid: text('call_sid').notNull().unique(),
    fromE164: text('from_e164').notNull(),
    toE164: text('to_e164').notNull(),
    forwardedFrom: text('forwarded_from'),
    stirVerstat: text('stir_verstat'),
    status: text('status', { enum: CALL_STATUSES }).notNull().default('ringing'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    aiStartedAt: tstz('ai_started_at'),
    endedAt: tstz('ended_at'),
    aiSeconds: integer('ai_seconds').notNull().default(0),
    billedMinutes: integer('billed_minutes').notNull().default(0),
    recordingKey: text('recording_key'),
    recordingStatus: text('recording_status', { enum: RECORDING_STATUSES }).notNull().default('none'),
    recordingSeconds: integer('recording_seconds'),
    consentRegime: text('consent_regime', { enum: CONSENT_REGIMES }),
    transcriptStored: boolean('transcript_stored').notNull().default(false),
    transferUserId: userRef('transfer_user_id'),
    transferResult: text('transfer_result', { enum: TRANSFER_RESULTS }),
    spamReason: text('spam_reason'),
    textBackMessageId: uuid('text_back_message_id'),
    ...timestamps(),
  },
  (t) => [
    unique('calls_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'calls_company_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversations.companyId, conversations.id],
    }),
    foreignKey({
      name: 'calls_company_text_back_message_fk',
      columns: [t.companyId, t.textBackMessageId],
      foreignColumns: [messages.companyId, messages.id],
    }),
    index('calls_company_started_idx').on(t.companyId, t.startedAt),
    index('calls_company_conversation_idx').on(t.companyId, t.conversationId),
    enumCheck('calls', 'status', t.status, CALL_STATUSES),
    enumCheck('calls', 'recording_status', t.recordingStatus, RECORDING_STATUSES),
    enumCheck('calls', 'consent_regime', t.consentRegime, CONSENT_REGIMES),
    enumCheck('calls', 'transfer_result', t.transferResult, TRANSFER_RESULTS),
  ],
);

export const conversationTurns = pgTable(
  'conversation_turns',
  {
    id: pk(),
    companyId: companyId(),
    conversationId: uuid('conversation_id').notNull(),
    callId: uuid('call_id'),
    position: integer('position').notNull(),
    speaker: text('speaker', { enum: TURN_SPEAKERS }).notNull(),
    text: text('text').notNull(),
    truncated: boolean('truncated').notNull().default(false),
    at: tstz('at').notNull().defaultNow(),
    model: text('model'),
    route: text('route', { enum: TURN_ROUTES }),
    routerMs: integer('router_ms'),
    firstTokenMs: integer('first_token_ms'),
    totalMs: integer('total_ms'),
    inputTokens: integer('input_tokens'),
    cachedTokens: integer('cached_tokens'),
    outputTokens: integer('output_tokens'),
    toolCalls: jsonb('tool_calls').$type<ToolCallRecord[]>(),
    guardHits: text('guard_hits').array().notNull().default([]),
  },
  (t) => [
    unique('conversation_turns_company_id_id_uniq').on(t.companyId, t.id),
    uniqueIndex('conversation_turns_conversation_position_uniq').on(t.conversationId, t.position),
    foreignKey({
      name: 'conversation_turns_company_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversations.companyId, conversations.id],
    }),
    foreignKey({
      name: 'conversation_turns_company_call_fk',
      columns: [t.companyId, t.callId],
      foreignColumns: [calls.companyId, calls.id],
    }),
    enumCheck('conversation_turns', 'speaker', t.speaker, TURN_SPEAKERS),
    enumCheck('conversation_turns', 'route', t.route, TURN_ROUTES),
  ],
);

/** A claim the assistant or a person took down for a customer (insurer, claim number, loss details). */
export const claimIntakes = pgTable(
  'claim_intakes',
  {
    id: pk(),
    companyId: companyId(),
    jobId: uuid('job_id'),
    conversationId: uuid('conversation_id'),
    insurer: text('insurer').notNull(),
    claimNumber: text('claim_number'),
    dateOfLoss: date('date_of_loss', { mode: 'string' }),
    description: text('description').notNull(),
    adjusterVisitAt: tstz('adjuster_visit_at'),
    takenBy: text('taken_by', { enum: CLAIM_TAKEN_BY }).notNull(),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'claim_intakes_company_job_fk',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'claim_intakes_company_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversations.companyId, conversations.id],
    }),
    enumCheck('claim_intakes', 'taken_by', t.takenBy, CLAIM_TAKEN_BY),
  ],
);

/** Numbers the company refuses to take calls or texts from. */
export const blockedNumbers = pgTable(
  'blocked_numbers',
  {
    id: pk(),
    companyId: companyId(),
    e164: text('e164').notNull(),
    reason: text('reason'),
    blockedBy: userRef('blocked_by'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('blocked_numbers_company_e164_uniq').on(t.companyId, t.e164)],
);

/**
 * Minutes a unit of work is worth, per baseline key. A missing row means the default in code, so
 * the table only holds what a company has changed. The key is plain text: the list of keys lives
 * with the step definitions, and a new key needs no migration.
 */
export const timeBaselines = pgTable(
  'time_baselines',
  {
    id: pk(),
    companyId: companyId(),
    key: text('key').notNull(),
    minutesPerUnit: numeric('minutes_per_unit', { precision: 6, scale: 2, mode: 'number' }).notNull(),
    ...timestamps(),
  },
  (t) => [unique('time_baselines_company_key_uniq').on(t.companyId, t.key)],
);

/**
 * The feed: one row per thing that happened to a task. Written only by the task service and never
 * updated or deleted (the grants in the next migration allow INSERT and SELECT only).
 */
export const agentTaskEvents = pgTable(
  'agent_task_events',
  {
    id: pk(),
    companyId: companyId(),
    taskId: uuid('task_id').notNull(),
    stepId: uuid('step_id'),
    kind: text('kind', { enum: AGENT_EVENT_KINDS }).notNull(),
    actorType: text('actor_type', { enum: ACTOR_TYPES }).notNull(),
    actorUserId: userRef('actor_user_id'),
    /** Counts and ids only, never message text or customer names. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'agent_task_events_company_task_fk',
      columns: [t.companyId, t.taskId],
      foreignColumns: [agentTasks.companyId, agentTasks.id],
    }),
    foreignKey({
      name: 'agent_task_events_company_step_fk',
      columns: [t.companyId, t.stepId],
      foreignColumns: [agentTaskSteps.companyId, agentTaskSteps.id],
    }),
    index('agent_task_events_company_at_idx').on(t.companyId, t.at.desc()),
    index('agent_task_events_task_idx').on(t.companyId, t.taskId, t.at),
    enumCheck('agent_task_events', 'kind', t.kind, AGENT_EVENT_KINDS),
    enumCheck('agent_task_events', 'actor_type', t.actorType, ACTOR_TYPES),
  ],
);

/** Per-company switches for each agent. A missing row means the agent is on. */
export const agentSettings = pgTable(
  'agent_settings',
  {
    id: pk(),
    companyId: companyId(),
    agent: text('agent', { enum: AGENTS }).notNull(),
    pausedAt: tstz('paused_at'),
    pausedBy: userRef('paused_by'),
    lastRunNowAt: tstz('last_run_now_at'),
    ...timestamps(),
  },
  (t) => [
    unique('agent_settings_company_agent_uniq').on(t.companyId, t.agent),
    enumCheck('agent_settings', 'agent', t.agent, AGENTS),
  ],
);

/** An audited owner recount of the minutes saved in a date range: the before and after totals. */
export const timeRecounts = pgTable(
  'time_recounts',
  {
    id: pk(),
    companyId: companyId(),
    byUserId: userRef('by_user_id').notNull(),
    fromAt: tstz('from').notNull(),
    toAt: tstz('to').notNull(),
    beforeMinutes: numeric('before_minutes', { precision: 12, scale: 2, mode: 'number' }).notNull(),
    afterMinutes: numeric('after_minutes', { precision: 12, scale: 2, mode: 'number' }).notNull(),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('time_recounts_company_at_idx').on(t.companyId, t.at)],
);

/** The insurance claim for a job (spec 6): one per job. */
export const claims = pgTable(
  'claims',
  {
    id: pk(),
    companyId: companyId(),
    jobId: uuid('job_id').notNull(),
    insurer: text('insurer'),
    claimNumber: text('claim_number'),
    dateOfLoss: date('date_of_loss', { mode: 'string' }),
    status: text('status', { enum: CLAIM_STATUSES }).notNull().default('not_filed'),
    adjusterName: text('adjuster_name'),
    adjusterPhone: text('adjuster_phone'),
    adjusterEmail: text('adjuster_email'),
    adjusterAppointmentId: uuid('adjuster_appointment_id'),
    deductibleCents: integer('deductible_cents'),
    notes: text('notes'),
    statusChangedAt: tstz('status_changed_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    unique('claims_company_id_id_uniq').on(t.companyId, t.id),
    /** One claim per job. */
    unique('claims_company_job_uniq').on(t.companyId, t.jobId),
    foreignKey({
      name: 'claims_company_job_fk',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'claims_company_adjuster_appointment_fk',
      columns: [t.companyId, t.adjusterAppointmentId],
      foreignColumns: [appointments.companyId, appointments.id],
    }),
    index('claims_company_status_idx').on(t.companyId, t.status),
    check('claims_deductible_cents_check', sql`${t.deductibleCents} >= 0`),
    enumCheck('claims', 'status', t.status, CLAIM_STATUSES),
  ],
);

/** Status history of a claim. `from_status` is null for the first event. */
export const claimEvents = pgTable(
  'claim_events',
  {
    id: pk(),
    companyId: companyId(),
    claimId: uuid('claim_id').notNull(),
    fromStatus: text('from_status', { enum: CLAIM_STATUSES }),
    toStatus: text('to_status', { enum: CLAIM_STATUSES }).notNull(),
    by: text('by_actor', { enum: CLAIM_EVENT_ACTORS }).notNull(),
    byUserId: userRef('by_user_id'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'claim_events_company_claim_fk',
      columns: [t.companyId, t.claimId],
      foreignColumns: [claims.companyId, claims.id],
    }),
    index('claim_events_claim_at_idx').on(t.companyId, t.claimId, t.at),
    enumCheck('claim_events', 'from_status', t.fromStatus, CLAIM_STATUSES),
    enumCheck('claim_events', 'to_status', t.toStatus, CLAIM_STATUSES),
    enumCheck('claim_events', 'by_actor', t.by, CLAIM_EVENT_ACTORS),
  ],
);

/** Every follow-up the Follow-up agent sent, so it never nags twice. */
export const followUpLog = pgTable(
  'follow_up_log',
  {
    id: pk(),
    companyId: companyId(),
    customerId: uuid('customer_id').notNull(),
    jobId: uuid('job_id'),
    kind: text('kind', { enum: FOLLOW_UP_KINDS }).notNull(),
    n: integer('n').notNull().default(1),
    messageId: uuid('message_id'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'follow_up_log_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    foreignKey({
      name: 'follow_up_log_company_job_fk',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'follow_up_log_company_message_fk',
      columns: [t.companyId, t.messageId],
      foreignColumns: [messages.companyId, messages.id],
    }),
    index('follow_up_log_customer_at_idx').on(t.companyId, t.customerId, t.at),
    index('follow_up_log_job_kind_idx').on(t.companyId, t.jobId, t.kind),
    check('follow_up_log_n_check', sql`${t.n} >= 1`),
    enumCheck('follow_up_log', 'kind', t.kind, FOLLOW_UP_KINDS),
  ],
);

/*
 * Storm Scout (spec 3.3, 4.1, 5). Door stop and exclusion footprint ids carry no foreign key: the
 * global building_footprints table is reloaded, so a hard link would break the loader (Ruling SH).
 */

/** A storm as one company sees it: how many of its customers and homes it hit, and what was done. */
export const companyStorms = pgTable(
  'company_storms',
  {
    id: pk(),
    companyId: companyId(),
    stormId: uuid('storm_id')
      .notNull()
      .references(() => storms.id),
    status: text('status', { enum: COMPANY_STORM_STATUSES }).notNull().default('new'),
    maxIn: numeric('max_in', { precision: 4, scale: 2, mode: 'number' }).notNull(),
    customersHit: integer('customers_hit').notNull().default(0),
    homesHit: integer('homes_hit').notNull().default(0),
    alertedAt: tstz('alerted_at'),
    planTaskId: uuid('plan_task_id'),
    lastMatchedAt: tstz('last_matched_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    unique('company_storms_company_id_id_uniq').on(t.companyId, t.id),
    unique('company_storms_company_storm_uniq').on(t.companyId, t.stormId),
    foreignKey({
      name: 'company_storms_company_plan_task_fk',
      columns: [t.companyId, t.planTaskId],
      foreignColumns: [agentTasks.companyId, agentTasks.id],
    }),
    enumCheck('company_storms', 'status', t.status, COMPANY_STORM_STATUSES),
  ],
);

/** One property a storm hit, with the hail size over it. */
export const stormHits = pgTable(
  'storm_hits',
  {
    id: pk(),
    companyId: companyId(),
    companyStormId: uuid('company_storm_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    customerId: uuid('customer_id'),
    hailIn: numeric('hail_in', { precision: 4, scale: 2, mode: 'number' }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('storm_hits_company_id_id_uniq').on(t.companyId, t.id),
    unique('storm_hits_storm_property_uniq').on(t.companyStormId, t.propertyId),
    foreignKey({
      name: 'storm_hits_company_company_storm_fk',
      columns: [t.companyId, t.companyStormId],
      foreignColumns: [companyStorms.companyId, companyStorms.id],
    }),
    foreignKey({
      name: 'storm_hits_company_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [properties.companyId, properties.id],
    }),
    foreignKey({
      name: 'storm_hits_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
  ],
);

/** A door-knocking route for one rep over one storm. */
export const doorRoutes = pgTable(
  'door_routes',
  {
    id: pk(),
    companyId: companyId(),
    companyStormId: uuid('company_storm_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    status: text('status', { enum: DOOR_ROUTE_STATUSES }).notNull().default('ready'),
    stops: integer('stops').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique('door_routes_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'door_routes_company_company_storm_fk',
      columns: [t.companyId, t.companyStormId],
      foreignColumns: [companyStorms.companyId, companyStorms.id],
    }),
    enumCheck('door_routes', 'status', t.status, DOOR_ROUTE_STATUSES),
  ],
);

export const doorStops = pgTable(
  'door_stops',
  {
    id: pk(),
    companyId: companyId(),
    routeId: uuid('route_id').notNull(),
    position: integer('position').notNull(),
    /** No foreign key on purpose: building_footprints is reloaded (Ruling SH). */
    footprintId: bigint('footprint_id', { mode: 'number' }),
    propertyId: uuid('property_id'),
    point: point4326('point').notNull(),
    address: text('address'),
    hailIn: numeric('hail_in', { precision: 4, scale: 2, mode: 'number' }),
    outcome: text('outcome', { enum: DOOR_OUTCOMES }),
    outcomeAt: tstz('outcome_at'),
    outcomeBy: uuid('outcome_by').references(() => users.id),
    createdCustomerId: uuid('created_customer_id'),
    createdJobId: uuid('created_job_id'),
    ...timestamps(),
  },
  (t) => [
    unique('door_stops_company_id_id_uniq').on(t.companyId, t.id),
    unique('door_stops_route_position_uniq').on(t.routeId, t.position),
    foreignKey({
      name: 'door_stops_company_route_fk',
      columns: [t.companyId, t.routeId],
      foreignColumns: [doorRoutes.companyId, doorRoutes.id],
    }),
    foreignKey({
      name: 'door_stops_company_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [properties.companyId, properties.id],
    }),
    foreignKey({
      name: 'door_stops_company_created_customer_fk',
      columns: [t.companyId, t.createdCustomerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    foreignKey({
      name: 'door_stops_company_created_job_fk',
      columns: [t.companyId, t.createdJobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    enumCheck('door_stops', 'outcome', t.outcome, DOOR_OUTCOMES),
  ],
);

/** Buildings a company never wants on a route. No foreign key on the footprint (Ruling SH). */
export const doorExclusions = pgTable(
  'door_exclusions',
  {
    id: pk(),
    companyId: companyId(),
    footprintId: bigint('footprint_id', { mode: 'number' }).notNull(),
    reason: text('reason'),
    ...timestamps(),
  },
  (t) => [
    unique('door_exclusions_company_id_id_uniq').on(t.companyId, t.id),
    unique('door_exclusions_company_footprint_uniq').on(t.companyId, t.footprintId),
  ],
);

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: pk(),
    companyId: companyId(),
    platform: text('platform', { enum: AD_PLATFORMS }).notNull(),
    externalAccountId: text('external_account_id').notNull(),
    status: text('status', { enum: AD_ACCOUNT_STATUSES }).notNull().default('pending'),
    name: text('name'),
    currency: text('currency'),
    linkedAt: tstz('linked_at'),
    lastErrorPlain: text('last_error_plain'),
    ...timestamps(),
  },
  (t) => [
    unique('ad_accounts_company_id_id_uniq').on(t.companyId, t.id),
    unique('ad_accounts_company_platform_uniq').on(t.companyId, t.platform),
    // Ruling BF: an external ad account belongs to one company. Global, so it sees every company's rows; a revoked row frees it.
    uniqueIndex('ad_accounts_platform_external_live_uq')
      .on(t.platform, t.externalAccountId)
      .where(sql`${t.status} <> 'revoked'`),
    enumCheck('ad_accounts', 'platform', t.platform, AD_PLATFORMS),
    enumCheck('ad_accounts', 'status', t.status, AD_ACCOUNT_STATUSES),
  ],
);

export const adCampaigns = pgTable(
  'ad_campaigns',
  {
    id: pk(),
    companyId: companyId(),
    companyStormId: uuid('company_storm_id').notNull(),
    stepId: uuid('step_id').notNull(),
    platform: text('platform', { enum: AD_PLATFORMS }).notNull(),
    externalCampaignId: text('external_campaign_id'),
    status: text('status', { enum: AD_CAMPAIGN_STATUSES }).notNull().default('creating'),
    dailyBudgetCents: integer('daily_budget_cents').notNull(),
    days: integer('days').notNull(),
    maxSpendCents: integer('max_spend_cents').notNull(),
    spendCents: integer('spend_cents').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
    landingRequests: integer('landing_requests').notNull().default(0),
    targets: jsonb('targets').$type<unknown[]>().notNull().default([]),
    creative: jsonb('creative').$type<Record<string, unknown>>().notNull().default({}),
    housingFallback: boolean('housing_fallback').notNull().default(false),
    /** Who paused it: 'roofline' stops the hourly sync, 'platform' (or null) keeps it syncing. See ad-campaign-sync.ts. */
    pausedBy: text('paused_by', { enum: AD_PAUSED_BY }),
    lastSyncedAt: tstz('last_synced_at'),
    errorKind: text('error_kind', { enum: AD_ERROR_KINDS }),
    errorPlain: text('error_plain'),
    ...timestamps(),
  },
  (t) => [
    unique('ad_campaigns_company_id_id_uniq').on(t.companyId, t.id),
    unique('ad_campaigns_company_step_uniq').on(t.companyId, t.stepId),
    uniqueIndex('ad_campaigns_platform_external_uniq')
      .on(t.platform, t.externalCampaignId)
      .where(sql`${t.externalCampaignId} is not null`),
    foreignKey({
      name: 'ad_campaigns_company_company_storm_fk',
      columns: [t.companyId, t.companyStormId],
      foreignColumns: [companyStorms.companyId, companyStorms.id],
    }),
    foreignKey({
      name: 'ad_campaigns_company_step_fk',
      columns: [t.companyId, t.stepId],
      foreignColumns: [agentTaskSteps.companyId, agentTaskSteps.id],
    }),
    enumCheck('ad_campaigns', 'platform', t.platform, AD_PLATFORMS),
    enumCheck('ad_campaigns', 'status', t.status, AD_CAMPAIGN_STATUSES),
    enumCheck('ad_campaigns', 'error_kind', t.errorKind, AD_ERROR_KINDS),
    enumCheck('ad_campaigns', 'paused_by', t.pausedBy, AD_PAUSED_BY),
  ],
);

/** The public landing page of a storm (spec 5): the code is in the page URL, so it is globally unique. */
export const stormPages = pgTable(
  'storm_pages',
  {
    id: pk(),
    companyId: companyId(),
    companyStormId: uuid('company_storm_id').notNull(),
    code: text('code').notNull(),
    activeUntil: tstz('active_until').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('storm_pages_company_id_id_uniq').on(t.companyId, t.id),
    unique('storm_pages_code_uniq').on(t.code),
    foreignKey({
      name: 'storm_pages_company_company_storm_fk',
      columns: [t.companyId, t.companyStormId],
      foreignColumns: [companyStorms.companyId, companyStorms.id],
    }),
  ],
);

/** An inspection request a homeowner sent from a storm page. */
export const stormRequests = pgTable(
  'storm_requests',
  {
    id: pk(),
    companyId: companyId(),
    stormPageId: uuid('storm_page_id').notNull(),
    name: text('name').notNull(),
    phoneE164: text('phone_e164').notNull(),
    address: text('address').notNull(),
    smsConsent: boolean('sms_consent').notNull().default(false),
    consentText: text('consent_text'),
    consentAt: tstz('consent_at'),
    customerId: uuid('customer_id'),
    jobId: uuid('job_id'),
    ipHash: text('ip_hash'),
    ...timestamps(),
  },
  (t) => [
    unique('storm_requests_company_id_id_uniq').on(t.companyId, t.id),
    unique('storm_requests_page_phone_uniq').on(t.stormPageId, t.phoneE164),
    foreignKey({
      name: 'storm_requests_company_storm_page_fk',
      columns: [t.companyId, t.stormPageId],
      foreignColumns: [stormPages.companyId, stormPages.id],
    }),
    foreignKey({
      name: 'storm_requests_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    foreignKey({
      name: 'storm_requests_company_job_fk',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
  ],
);

/** Addresses that asked not to get marketing email from a company. */
export const emailOptOuts = pgTable(
  'email_opt_outs',
  {
    id: pk(),
    companyId: companyId(),
    email: citext('email').notNull(),
    source: text('source', { enum: EMAIL_OPT_OUT_SOURCES }).notNull(),
    at: tstz('at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    unique('email_opt_outs_company_id_id_uniq').on(t.companyId, t.id),
    unique('email_opt_outs_company_email_uniq').on(t.companyId, t.email),
    enumCheck('email_opt_outs', 'source', t.source, EMAIL_OPT_OUT_SOURCES),
  ],
);

/** A photo a rep took at a storm door (the file itself is in stored_files). */
export const stormPhotos = pgTable(
  'storm_photos',
  {
    id: pk(),
    companyId: companyId(),
    storedFileId: uuid('stored_file_id').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('storm_photos_company_id_id_uniq').on(t.companyId, t.id),
    unique('storm_photos_company_stored_file_uniq').on(t.companyId, t.storedFileId),
    foreignKey({
      name: 'storm_photos_company_stored_file_fk',
      columns: [t.companyId, t.storedFileId],
      foreignColumns: [storedFiles.companyId, storedFiles.id],
    }),
  ],
);

/**
 * A facade photo as kept (server side): the view's FacadePhoto plus where its bytes are (object-store key; null when
 * they could not be stored), the date Google's terms say it must be gone by (30 days after download), and the camera
 * it was taken with, so marked windows can be sized again later.
 */
export type StoredFacadePhoto = FacadePhoto & {
  key: string | null;
  fetchedAt: string;
  deleteBy: string;
  /** When the google-retention job deleted the photo's bytes (key is then null). Absent while the photo is kept. */
  deletedAt?: string;
  pitch: number;
  /** Windows are counted on this photo (a whole-front shot of a wide front is shown, not counted on). */
  measure: boolean;
  /** Compass bearings [from, to] of the front this photo counts windows on. */
  range: [number, number];
  /**
   * The automatic line-up's result: heading, pitch and roll corrections (degrees; pitch and roll absent on older rows:
   * 0) and best eave height (metres), when it was good.
   */
  lineup: { headingCorrectionDeg: number; pitchCorrectionDeg?: number; rollCorrectionDeg?: number; eaveM: number | null } | null;
  /** A person's corner fit (wins over the line-up). */
  personFit: { headingCorrectionDeg: number; distanceScale: number; eaveM: number; errorPx: number } | null;
};

/** What the window measurement was worked out from (server side): the outline, the camera spot and the heights. */
export type WindowGeometry = {
  /** The outline used ([lng, lat], open ring). */
  ring: LngLat[];
  /** Where the Street View camera stood, [lng, lat] (null without imagery). */
  camera: LngLat | null;
  /** The main eave's height above the ground from Google's height map, metres (null when unknown). */
  eaveHeightM: number | null;
  /**
   * Where the outline came from: a Microsoft footprint, else Google's roof: the outline of its roof mask (the roof in 3D's,
   * overhangs included), else Google Solar's box for the building (older rows; a last resort).
   */
  outlineSource: 'footprint' | 'solar-mask' | 'solar-box';
  /** Each outline edge's eave above the ground (edge i: ring[i] -> ring[i + 1]), metres; null where unread. Absent on older rows. */
  wallEavesM?: (number | null)[];
  /** The roof's top above the ground, metres. Absent on older rows. */
  ridgeM?: number | null;
  /** The whole outline's lowest eave (what older rows used for the walls), metres, kept for comparison. */
  lowestEaveM?: number | null;
};

/**
 * A window photo a person uploaded (server side): the view's WindowPhotoUpload (displayed size) plus where its bytes
 * are, its kind, its EXIF orientation (the bytes are kept as uploaded) and its byte size. The company's own photo: kept
 * with the measurement (no 30-day rule).
 */
export type StoredWindowUpload = WindowPhotoUpload & { key: string; kind: 'jpeg' | 'png'; orientation: number; bytes: number; uploadedAt: string };

/** Measure windows (spec: windows feature): the walls estimate, the front photos and the windows marked on them. */
export const windowMeasurements = pgTable(
  'window_measurements',
  {
    id: pk(),
    companyId: companyId(),
    propertyId: uuid('property_id').notNull(),
    address: text('address').notNull(),
    /** [lng, lat] of the home. */
    center: jsonb('center').$type<LngLat>().notNull(),
    photos: jsonb('photos').$type<StoredFacadePhoto[]>().notNull().default([]),
    /** Windows found by the optional detector (marked ones are in adjustments.marked and sized on read). */
    windows: jsonb('windows').$type<MeasuredWindow[]>().notNull().default([]),
    /** The walls-only estimate (covers 'all-sides'), kept as worked out at measure time. */
    estimated: jsonb('estimated').$type<EstimatedWindows>(),
    stories: integer('stories'),
    geometry: jsonb('geometry').$type<WindowGeometry>(),
    detector: text('detector', { enum: WINDOW_DETECTORS }),
    missingReason: text('missing_reason', { enum: WINDOWS_MISS_REASONS }),
    reviewReasons: jsonb('review_reasons').$type<string[]>().notNull().default([]),
    adjustments: jsonb('adjustments').$type<WindowAdjustments>().notNull().default({ excludedWindowIds: [], manualCounts: {} }),
    tookMs: integer('took_ms').notNull(),
    /** Photos of single windows taken on site (at most 40). */
    uploads: jsonb('uploads').$type<StoredWindowUpload[]>().notNull().default([]),
    /** Google's Street View terms: the photos' bytes are deleted by then (30 days after download). */
    photosDeleteBy: tstz('photos_delete_by'),
    createdByUserId: userRef('created_by_user_id'),
    ...timestamps(),
  },
  (t) => [
    unique('window_measurements_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'window_measurements_company_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [properties.companyId, properties.id],
    }),
    index('window_measurements_property_idx').on(t.propertyId),
    index('window_measurements_photos_delete_by_idx').on(t.photosDeleteBy),
    enumCheck('window_measurements', 'detector', t.detector, WINDOW_DETECTORS),
    enumCheck('window_measurements', 'missing_reason', t.missingReason, WINDOWS_MISS_REASONS),
  ],
);

/**
 * An instant-quote estimate for one typed address (public /q/:slug). `result` is exactly the ranges the page was
 * shown (PublicQuoteEstimate minus the id); a fresh one is reused for the same address for 30 days so a repeat
 * visitor costs no paid map calls. 'fallback' rows were not measured (the daily limit, or no roof found).
 */
export const quoteEstimates = pgTable(
  'quote_estimates',
  {
    id: pk(),
    companyId: companyId(),
    /** The typed address, lowercased with spaces collapsed: the cache key before any lookup. */
    inputKey: text('input_key').notNull(),
    /** normalizeAddressKey of the found address; null when it was not looked up. */
    addressKey: text('address_key'),
    address: text('address').notNull(),
    status: text('status', { enum: ['ready', 'fallback'] }).notNull(),
    /** True when this row spent paid calls (counts toward the daily cap). */
    measured: boolean('measured').notNull().default(false),
    propertyId: uuid('property_id'),
    measurementId: uuid('measurement_id'),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    ipHash: text('ip_hash'),
    expiresAt: tstz('expires_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('quote_estimates_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'quote_estimates_company_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [properties.companyId, properties.id],
    }),
    foreignKey({
      name: 'quote_estimates_company_measurement_fk',
      columns: [t.companyId, t.measurementId],
      foreignColumns: [measurements.companyId, measurements.id],
    }),
    index('quote_estimates_company_input_idx').on(t.companyId, t.inputKey),
    index('quote_estimates_company_address_idx').on(t.companyId, t.addressKey),
    index('quote_estimates_company_created_idx').on(t.companyId, t.createdAt),
    enumCheck('quote_estimates', 'status', t.status, ['ready', 'fallback']),
  ],
);

/**
 * A homeowner's request from the instant-quote page: who asked, for what, the consent they ticked (the exact text and
 * its version, when, and a hash of their address; never the address itself), and the customer, job and visit made.
 */
export const quoteRequests = pgTable(
  'quote_requests',
  {
    id: pk(),
    companyId: companyId(),
    quoteEstimateId: uuid('quote_estimate_id'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    phoneE164: text('phone_e164').notNull(),
    postalCode: text('postal_code').notNull(),
    products: text('products').array().notNull(),
    consentText: text('consent_text').notNull(),
    consentVersion: text('consent_version').notNull(),
    consentAt: tstz('consent_at').notNull(),
    /**
     * The separate, optional "text me" box was ticked (its exact sentence in text_consent_text). Evidence only: the
     * customer's texting consent is not changed by a form (Ruling BF).
     */
    textConsent: boolean('text_consent').notNull().default(false),
    textConsentText: text('text_consent_text'),
    ipHash: text('ip_hash'),
    customerId: uuid('customer_id'),
    jobId: uuid('job_id'),
    appointmentId: uuid('appointment_id'),
    ...timestamps(),
  },
  (t) => [
    unique('quote_requests_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'quote_requests_company_estimate_fk',
      columns: [t.companyId, t.quoteEstimateId],
      foreignColumns: [quoteEstimates.companyId, quoteEstimates.id],
    }),
    foreignKey({
      name: 'quote_requests_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }),
    foreignKey({
      name: 'quote_requests_company_job_fk',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'quote_requests_company_appointment_fk',
      columns: [t.companyId, t.appointmentId],
      foreignColumns: [appointments.companyId, appointments.id],
    }),
    index('quote_requests_company_created_idx').on(t.companyId, t.createdAt),
    check('quote_requests_products_check', sql`${t.products} <@ array['windows','roof','gutters']::text[]`),
  ],
);

/**
 * Window factory orders: the windows of one window measurement that were measured on site (photo windows), as lines a
 * window factory builds from. One order per measurement. 'draft' is edited; 'ready' locks the order sizes (owner or
 * office); 'sent' records who exported it to the factory (the export itself is a manual download).
 */
export const windowOrders = pgTable(
  'window_orders',
  {
    id: pk(),
    companyId: companyId(),
    windowMeasurementId: uuid('window_measurement_id').notNull(),
    status: text('status', { enum: WINDOW_ORDER_STATUSES }).notNull().default('draft'),
    lines: jsonb('lines').$type<WindowOrderLine[]>().notNull().default([]),
    /** The company's order settings as they were when the order was made (refreshed while a draft, fixed once ready). */
    settings: jsonb('settings').$type<WindowOrderSettings>().notNull(),
    poNumber: text('po_number').notNull().default(''),
    readyAt: tstz('ready_at'),
    readyByUserId: userRef('ready_by_user_id'),
    sentAt: tstz('sent_at'),
    sentByUserId: userRef('sent_by_user_id'),
    createdByUserId: userRef('created_by_user_id'),
    ...timestamps(),
  },
  (t) => [
    unique('window_orders_company_id_id_uniq').on(t.companyId, t.id),
    unique('window_orders_company_measurement_uniq').on(t.companyId, t.windowMeasurementId),
    foreignKey({
      name: 'window_orders_company_measurement_fk',
      columns: [t.companyId, t.windowMeasurementId],
      foreignColumns: [windowMeasurements.companyId, windowMeasurements.id],
    }),
    enumCheck('window_orders', 'status', t.status, WINDOW_ORDER_STATUSES),
  ],
);

/**
 * A homeowner's request from the phone app (the public homeowner API, /api/public/homeowner/:slug). One row per
 * homeowner start: found by its id, proved by a bearer token of which only the SHA-256 hash is kept (token_hash; the
 * token itself is never stored or logged) and good until expires_at. It points at what was worked out for the address
 * (quote_estimates: the 30-day cache the instant quote page shares) and at the window measurement that holds the
 * windows the homeowner measured (window_measurements.adjustments.photoWindows, each with source 'homeowner-app'). The
 * contact form files the request with the company as a quote_requests row (the consent evidence, customer and Lead job
 * of source 'app'); before that the request holds no personal detail except the home's address.
 */
export const homeownerRequests = pgTable(
  'homeowner_requests',
  {
    id: pk(),
    companyId: companyId(),
    /** SHA-256 of the bearer token, hex. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    /** What the homeowner asked about. */
    services: text('services').array().notNull(),
    /** The address as found (street, city, state and ZIP), or as typed when the lookup was down. */
    address: text('address').notNull(),
    /** 'callback': no online estimate (an apartment, a house a person must see, the daily limit): the company calls. */
    status: text('status', { enum: ['ready', 'callback'] }).notNull(),
    callbackReason: text('callback_reason', { enum: HOMEOWNER_CALLBACK_REASONS }),
    quoteEstimateId: uuid('quote_estimate_id'),
    propertyId: uuid('property_id'),
    /** Made when the first photo or window arrives. */
    windowMeasurementId: uuid('window_measurement_id'),
    /** The number of windows the homeowner says the house has; replaces the address estimate's count. */
    windowCountOverride: integer('window_count_override'),
    /** Set when the contact form filed the request: the consent evidence, customer, Lead job and visit are on it. */
    quoteRequestId: uuid('quote_request_id'),
    /** The homeowner asked to be called to set up the visit instead of picking a time. */
    callMe: boolean('call_me').notNull().default(false),
    /** A keyed hash of the requester's IP (never the address). */
    ipHash: text('ip_hash'),
    ...timestamps(),
  },
  (t) => [
    unique('homeowner_requests_company_id_id_uniq').on(t.companyId, t.id),
    unique('homeowner_requests_token_hash_uniq').on(t.tokenHash),
    foreignKey({
      name: 'homeowner_requests_company_estimate_fk',
      columns: [t.companyId, t.quoteEstimateId],
      foreignColumns: [quoteEstimates.companyId, quoteEstimates.id],
    }),
    foreignKey({
      name: 'homeowner_requests_company_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [properties.companyId, properties.id],
    }),
    foreignKey({
      name: 'homeowner_requests_company_measurement_fk',
      columns: [t.companyId, t.windowMeasurementId],
      foreignColumns: [windowMeasurements.companyId, windowMeasurements.id],
    }),
    foreignKey({
      name: 'homeowner_requests_company_quote_request_fk',
      columns: [t.companyId, t.quoteRequestId],
      foreignColumns: [quoteRequests.companyId, quoteRequests.id],
    }),
    index('homeowner_requests_company_created_idx').on(t.companyId, t.createdAt),
    index('homeowner_requests_property_idx').on(t.companyId, t.propertyId),
    enumCheck('homeowner_requests', 'status', t.status, ['ready', 'callback']),
    enumCheck('homeowner_requests', 'callback_reason', t.callbackReason, HOMEOWNER_CALLBACK_REASONS),
    check('homeowner_requests_callback_pair_check', sql`(${t.status} = 'callback') = (${t.callbackReason} is not null)`),
    check('homeowner_requests_services_check', sql`cardinality(${t.services}) between 1 and 3 and ${t.services} <@ array['windows','roof','gutters']::text[]`),
    check('homeowner_requests_window_count_check', sql`${t.windowCountOverride} is null or ${t.windowCountOverride} between 1 and 80`),
  ],
);

/**
 * A multi-frame window scan from the homeowner app (docs/windows/scan-contract.md): the frames (camera poses and the
 * uploads they are pictures of), the corner marks, what the phone computed and what the server computed from the same
 * frames and marks, and the review that follows when a quality gate fails (a junior reviewer, then a senior one). The
 * window itself stays in the request's window measurement (adjustments.photoWindows); a scan that ends 'measured' is the
 * size shown for it.
 */
export const windowScans = pgTable(
  'window_scans',
  {
    id: pk(),
    companyId: companyId(),
    homeownerRequestId: uuid('homeowner_request_id').notNull(),
    /** The phone's scan id (a UUID): the same scan sent twice is one scan. */
    scanId: text('scan_id').notNull(),
    /** The window's id in the request's photoWindows. */
    windowId: text('window_id').notNull(),
    app: text('app'),
    device: text('device'),
    wall: jsonb('wall').$type<ScanWall | null>(),
    frames: jsonb('frames').$type<ScanFrame[]>().notNull(),
    /** The marks now (the reviewers' edits included). */
    marks: jsonb('marks').$type<ScanMark[]>().notNull(),
    /** The marks as the phone sent them. */
    marksOriginal: jsonb('marks_original').$type<ScanMark[]>().notNull(),
    phoneResult: jsonb('phone_result').$type<ScanResult | null>(),
    /** The server's result for `marks` (the one that counts). */
    serverResult: jsonb('server_result').$type<ScanResult>().notNull(),
    status: text('status', { enum: SCAN_STATUSES }).notNull(),
    expedite: boolean('expedite').notNull().default(false),
    slaDueAt: tstz('sla_due_at').notNull(),
    juniorUserId: userRef('junior_user_id'),
    juniorAt: tstz('junior_at'),
    seniorUserId: userRef('senior_user_id'),
    seniorAt: tstz('senior_at'),
    /** How a reviewed scan ended: 'measured' or 'visit_required' (null while open and for an auto-accepted scan). */
    outcome: text('outcome', { enum: SCAN_OUTCOMES }),
    outcomeReason: text('outcome_reason'),
    /** A senior reviewer finalised 'measured' although a gate failed. */
    overrode: boolean('overrode').notNull().default(false),
    history: jsonb('history').$type<ScanHistoryEvent[]>().notNull().default(sql`'[]'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    unique('window_scans_company_id_id_uniq').on(t.companyId, t.id),
    unique('window_scans_request_scan_uniq').on(t.companyId, t.homeownerRequestId, t.scanId),
    foreignKey({
      name: 'window_scans_company_request_fk',
      columns: [t.companyId, t.homeownerRequestId],
      foreignColumns: [homeownerRequests.companyId, homeownerRequests.id],
    }),
    index('window_scans_company_status_idx').on(t.companyId, t.status, t.createdAt),
    index('window_scans_window_idx').on(t.companyId, t.homeownerRequestId, t.windowId),
    enumCheck('window_scans', 'status', t.status, SCAN_STATUSES),
    enumCheck('window_scans', 'outcome', t.outcome, SCAN_OUTCOMES),
    check('window_scans_visit_reason_check', sql`${t.status} <> 'visit_required' or (${t.outcomeReason} is not null and length(btrim(${t.outcomeReason})) > 0)`),
  ],
);
