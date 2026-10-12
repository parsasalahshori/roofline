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
  type WorkHours,
} from '@roofline/shared';
import { bytea, enumCheck, pk, point4326, timestamps, tstz } from './columns.ts';
import {
  APPOINTMENT_KINDS,
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUSES,
  CALENDAR_CONNECTION_STATUSES,
  CALENDAR_PROVIDERS,
  CALL_STATUSES,
  CLAIM_TAKEN_BY,
  CONFIRMED_VIA,
  CONSENT_REGIMES,
  CONVERSATION_CHANNELS,
  CONVERSATION_OUTCOMES,
  CONVERSATION_STATUSES,
  EARLY_DELIVERY_STATUSES,
  HANDLED_BY,
  IDENTITY_LEVELS,
  INTEGRATION_STATUSES,
  QUOTE_STATUSES,
  RECORDING_STATUSES,
  TASK_MODES,
  TRANSFER_RESULTS,
  TURN_ROUTES,
  TURN_SPEAKERS,
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
  'conversations',
  'calls',
  'conversation_turns',
  'claim_intakes',
  'blocked_numbers',
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
    ...timestamps(),
  },
  (t) => [
    check('company_settings_marketing_cap_per_7d_check', sql`${t.marketingCapPer7d} between 0 and 2`),
    check('company_settings_travel_buffer_minutes_check', sql`${t.travelBufferMinutes} between 0 and 120`),
    check('company_settings_min_notice_minutes_check', sql`${t.minNoticeMinutes} between 0 and 4320`),
    check('company_settings_stuck_after_days_check', sql`${t.stuckAfterDays} between 3 and 90`),
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
    /** Front Desk: the conversation a text belongs to (null for texts outside Front Desk). */
    conversationId: uuid('conversation_id'),
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
