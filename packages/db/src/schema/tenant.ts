import { sql } from 'drizzle-orm';
import {
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
  DEFAULT_WORK_HOURS,
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
  type WorkHours,
} from '@roofline/shared';
import { bytea, enumCheck, pk, point4326, timestamps, tstz } from './columns.ts';
import {
  APPOINTMENT_KINDS,
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUSES,
  CALENDAR_CONNECTION_STATUSES,
  CALENDAR_PROVIDERS,
  CLAIM_EVENT_ACTORS,
  CLAIM_STATUSES,
  EARLY_DELIVERY_STATUSES,
  FOLLOW_UP_KINDS,
  INTEGRATION_STATUSES,
  QUOTE_STATUSES,
  TASK_MODES,
  USAGE_KINDS,
} from './enums.ts';
import { companies, users } from './global.ts';

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
  'claims',
  'claim_events',
  'follow_up_log',
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
    ...timestamps(),
  },
  (t) => [
    check('company_settings_marketing_cap_per_7d_check', sql`${t.marketingCapPer7d} between 0 and 2`),
    check('company_settings_travel_buffer_minutes_check', sql`${t.travelBufferMinutes} between 0 and 120`),
    check('company_settings_min_notice_minutes_check', sql`${t.minNoticeMinutes} between 0 and 4320`),
    check('company_settings_stuck_after_days_check', sql`${t.stuckAfterDays} between 3 and 90`),
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
    ...timestamps(),
  },
  (t) => [
    unique('messages_company_id_id_uniq').on(t.companyId, t.id),
    foreignKey({
      name: 'messages_company_customer_fk',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
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
