import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
  GATE_RULES,
  JOB_SOURCES,
  JOB_STAGES,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  MESSAGE_PURPOSES,
  MESSAGE_STATUSES,
  SMS_CONSENT_SOURCES,
  STEP_STATUSES,
  TASK_STATUSES,
} from '@roofline/shared';
import { bytea, enumCheck, pk, point4326, timestamps, tstz } from './columns.ts';
import { INTEGRATION_STATUSES, TASK_MODES, USAGE_KINDS } from './enums.ts';
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
    ...timestamps(),
  },
  (t) => [check('company_settings_marketing_cap_per_7d_check', sql`${t.marketingCapPer7d} between 0 and 2`)],
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
    archivedAt: tstz('archived_at'),
    ...timestamps(),
  },
  (t) => [
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
    index('jobs_customer_idx').on(t.customerId),
    index('jobs_property_idx').on(t.propertyId),
    index('jobs_assigned_idx').on(t.assignedUserId),
    enumCheck('jobs', 'stage', t.stage, JOB_STAGES),
    enumCheck('jobs', 'source', t.source, JOB_SOURCES),
  ],
);

/** The timeline for any customer, property or job. */
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
    at: tstz('at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index('usage_events_company_at_idx').on(t.companyId, t.at),
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
