import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { CAMPAIGN_STATUSES, COMPANY_STATUSES, ROLES } from '@roofline/shared';
import { bytea, citext, enumCheck, multiPolygon, pk, point4326, polygon4326, timestamps, tstz } from './columns.ts';
import { FOOTPRINT_STATE_STATUSES, MEMBERSHIP_STATUSES, PHONE_NUMBER_PURPOSES, USER_TOKEN_KINDS } from './enums.ts';

/*
 * Global tables (spec 3.1): read before a company is known, so they are not tenant-scoped.
 * Several of them still carry a company_id (memberships, invites, phone numbers, registrations).
 */

export const users = pgTable('users', {
  id: pk(),
  email: citext('email').notNull().unique(),
  name: text('name').notNull(),
  phoneE164: text('phone_e164'),
  passwordHash: text('password_hash'),
  googleSub: text('google_sub').unique(),
  emailVerifiedAt: tstz('email_verified_at'),
  ...timestamps(),
});

export const userTokens = pgTable(
  'user_tokens',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: USER_TOKEN_KINDS }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    ...timestamps(),
  },
  (t) => [enumCheck('user_tokens', 'kind', t.kind, USER_TOKEN_KINDS), index('user_tokens_user_idx').on(t.userId)],
);

export const companies = pgTable(
  'companies',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    legalName: text('legal_name'),
    phoneE164: text('phone_e164'),
    email: text('email'),
    website: text('website'),
    addressStreet: text('address_street'),
    addressCity: text('address_city'),
    addressState: text('address_state'),
    addressZip: text('address_zip'),
    timezone: text('timezone').notNull().default('America/Chicago'),
    serviceArea: multiPolygon('service_area'),
    logoUrl: text('logo_url'),
    status: text('status', { enum: COMPANY_STATUSES }).notNull().default('trial'),
    trialEndsAt: tstz('trial_ends_at'),
    stripeCustomerId: text('stripe_customer_id').unique(),
    planKey: text('plan_key'),
    /** Where the company works from, `[longitude, latitude]`, SRID 4326. Null until set. */
    location: point4326('location'),
    /** How far the company travels for work: one of 10, 20, 40 or 60 miles. */
    serviceAreaMiles: integer('service_area_miles'),
    stripeSubscriptionId: text('stripe_subscription_id').unique(),
    billingEventAt: tstz('billing_event_at'),
    billingPeriodStart: tstz('billing_period_start'),
    pastDueAt: tstz('past_due_at'),
    ...timestamps(),
  },
  (t) => [
    enumCheck('companies', 'status', t.status, COMPANY_STATUSES),
    check('companies_service_area_miles_check', sql`${t.serviceAreaMiles} in (10, 20, 40, 60)`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ROLES }).notNull(),
    canApproveSpend: boolean('can_approve_spend').notNull().default(false),
    status: text('status', { enum: MEMBERSHIP_STATUSES }).notNull().default('active'),
    /** The calendar day (company time zone) the Today window last opened for this member. */
    lastTodayShownOn: date('last_today_shown_on', { mode: 'string' }),
    /** Front Desk: the number a live call is transferred to for this member (E.164), null when none. */
    transferPhoneE164: text('transfer_phone_e164'),
    /** Front Desk: position in the ring order for the team, lowest first; null when not on call. */
    onCallOrder: integer('on_call_order'),
    /** When the member acknowledged that calls may be recorded. */
    recordingAckAt: tstz('recording_ack_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('memberships_company_user_uniq').on(t.companyId, t.userId),
    index('memberships_user_idx').on(t.userId),
    enumCheck('memberships', 'role', t.role, ROLES),
    enumCheck('memberships', 'status', t.status, MEMBERSHIP_STATUSES),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    email: citext('email').notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    ...timestamps(),
  },
  (t) => [index('invites_company_idx').on(t.companyId), enumCheck('invites', 'role', t.role, ROLES)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activeCompanyId: uuid('active_company_id').references(() => companies.id),
    expiresAt: tstz('expires_at').notNull(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    ...timestamps(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const companyPhoneNumbers = pgTable(
  'company_phone_numbers',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    e164: text('e164').notNull().unique(),
    /** `sms` and/or `voice`. */
    capabilities: text('capabilities').array().notNull().default([]),
    providerSid: text('provider_sid'),
    purpose: text('purpose', { enum: PHONE_NUMBER_PURPOSES }).notNull().default('main'),
    status: text('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    index('company_phone_numbers_company_idx').on(t.companyId),
    enumCheck('company_phone_numbers', 'purpose', t.purpose, PHONE_NUMBER_PURPOSES),
  ],
);

/** One row per company. A missing row means campaign status `none`. */
export const textingRegistrations = pgTable(
  'texting_registrations',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .unique()
      .references(() => companies.id),
    subaccountSid: text('subaccount_sid'),
    subaccountAuthTokenEncrypted: bytea('subaccount_auth_token_encrypted'),
    brandSid: text('brand_sid'),
    brandStatus: text('brand_status'),
    campaignSid: text('campaign_sid'),
    campaignStatus: text('campaign_status', { enum: CAMPAIGN_STATUSES }).notNull().default('none'),
    messagingServiceSid: text('messaging_service_sid'),
    submittedAt: tstz('submitted_at'),
    approvedAt: tstz('approved_at'),
    rejectionReasonPlain: text('rejection_reason_plain'),
    customerProfileSid: text('customer_profile_sid'),
    trustProductSid: text('trust_product_sid'),
    brandInfo: jsonb('brand_info').$type<Record<string, unknown>>(),
    /** Fields the carrier rejected, so the registration screen can point at them. */
    rejectedFields: text('rejected_fields').array().notNull().default([]),
    lastCheckedAt: tstz('last_checked_at'),
    ...timestamps(),
  },
  (t) => [
    enumCheck('texting_registrations', 'campaign_status', t.campaignStatus, CAMPAIGN_STATUSES),
    /** One registration per messaging service (the parked F3 index, Ruling AO). Null is not counted. */
    uniqueIndex('texting_registrations_messaging_service_sid_uniq')
      .on(t.messagingServiceSid)
      .where(sql`${t.messagingServiceSid} is not null`),
  ],
);

/** Provider webhook deliveries already handled, so repeated deliveries are ignored. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: pk(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('webhook_events_provider_event_uniq').on(t.provider, t.eventId)],
);

/*
 * Building footprints (spec 3.1, 8): public outlines loaded by the footprint loader job. No company
 * and no RLS: `app_tenant` may read them, only `app_system` writes (migration 0016).
 */

export const buildingFootprints = pgTable(
  'building_footprints',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Two-letter USPS state code. */
    state: char('state', { length: 2 }).notNull(),
    geom: polygon4326('geom').notNull(),
    areaSqFt: numeric('area_sq_ft', { precision: 12, scale: 1, mode: 'number' }).notNull(),
    source: text('source').notNull(),
    /** The provider's own id for the building, when it has one. */
    sourceRef: text('source_ref'),
  },
  (t) => [index('building_footprints_geom_gist').using('gist', t.geom), index('building_footprints_state_idx').on(t.state)],
);

/** Load state per state (one row per state): what the loader is doing and why it failed, in plain words. */
export const buildingFootprintStates = pgTable(
  'building_footprint_states',
  {
    state: char('state', { length: 2 }).primaryKey(),
    status: text('status').notNull(),
    buildings: integer('buildings'),
    sourceUrl: text('source_url'),
    startedAt: tstz('started_at'),
    loadedAt: tstz('loaded_at'),
    errorPlain: text('error_plain'),
  },
  (t) => [enumCheck('building_footprint_states', 'status', t.status, FOOTPRINT_STATE_STATUSES)],
);

/**
 * Cache of Twilio Lookup line types (global: a number's line type does not depend on the company).
 * Read and written by the system role only.
 */
export const lineLookups = pgTable('line_lookups', {
  e164: text('e164').primaryKey(),
  lineType: text('line_type').notNull(),
  lookedUpAt: tstz('looked_up_at').notNull().defaultNow(),
});
