import { boolean, date, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { CAMPAIGN_STATUSES, COMPANY_STATUSES, ROLES } from '@roofline/shared';
import { bytea, citext, enumCheck, multiPolygon, pk, timestamps, tstz } from './columns.ts';
import { MEMBERSHIP_STATUSES, PHONE_NUMBER_PURPOSES, USER_TOKEN_KINDS } from './enums.ts';

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
    ...timestamps(),
  },
  (t) => [enumCheck('companies', 'status', t.status, COMPANY_STATUSES)],
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
    ...timestamps(),
  },
  (t) => [enumCheck('texting_registrations', 'campaign_status', t.campaignStatus, CAMPAIGN_STATUSES)],
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
