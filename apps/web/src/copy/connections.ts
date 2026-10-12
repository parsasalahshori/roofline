import type { AdAccountReason } from '../api/types.ts';

/** Settings, Connections: where the ad accounts get connected. Vendor names live in this file only. */
export const connections = {
  /** The one line about connections that is still to come. */
  later: 'More connections are coming with setup.',
  /** The names of the two ad accounts, one name each everywhere. */
  googleAds: 'Google Ads',
  meta: 'Facebook and Instagram (Meta)',
  /** The two sides of the ad budget split (Settings, Storm). */
  googleShareLabel: 'Share for Google Ads',
  metaShareLabel: 'Share for Facebook and Instagram (Meta)',

  /** The words both ad account cards share. */
  stepsLabel: 'How to connect',
  connect: 'Connect',
  checkAgain: 'Check again',
  remove: 'Remove',
  statusLabel: 'Status',
  ownerOnly: 'Only the owner can connect or remove ad accounts.',
  /** `id` is the account's ID as the platform names it. */
  accountId: (id: string) => `Account ID ${id}`,
  /** What a person reads beside an account's status, by its status. */
  statuses: {
    pending: 'Waiting for you to accept',
    active: 'Connected',
    error: 'Needs attention',
    revoked: 'Removed',
  } satisfies Record<'pending' | 'active' | 'error' | 'revoked', string>,
  /** Plain sentences for why an account is not running yet. Never the platform's own words. */
  reasons: {
    policy: 'The ad platform will not run ads from this account. Check its policies, then ask us what to change.',
    payment: 'The account needs a payment method before it can run ads.',
    access: 'We do not have access to this account yet. Check that it is shared with us, then press Check again.',
    targeting: 'This account cannot target the area yet. Ask us what to change.',
    other: 'This account needs attention. Ask us what to check.',
  } satisfies Record<AdAccountReason, string>,

  /** Google Ads: the steps and the customer ID field. */
  googleStepId: 'Type your Google Ads customer ID in the field below.',
  /** `managerId` is Roofline's Google manager account ID. */
  googleStepManager: (managerId: string) => `We send a link request from our manager account ${managerId}.`,
  googleStepManagerSoon: 'We send a link request from our manager account. Its ID shows here once it is set up.',
  googleStepAccept: 'In Google Ads, open Access and security, then Accept the link request.',
  googleStepCheck: 'Press Check again.',
  googleCustomerId: 'Google Ads customer ID',
  googleCustomerIdHelp: 'Ten digits, with or without dashes',
  googleIdInvalid: 'Enter the ten-digit customer ID from Google Ads.',

  /** Facebook and Instagram (Meta): the steps and the ad account ID field. */
  metaStepBusiness: (businessId: string) =>
    `In Business Settings, add our business as a partner on your ad account. Our Business ID is ${businessId}.`,
  metaStepBusinessSoon:
    'In Business Settings, add our business as a partner on your ad account. Our Business ID shows here once it is set up.',
  metaStepShare: 'Share the ad account with us.',
  metaStepId: 'Type the ad account ID in the field below.',
  metaStepConnect: 'Press Connect, then press Check again.',
  metaAdAccountId: 'Ad account ID',
  metaAdAccountIdHelp: 'Starts with act_, or is just the digits',
} as const;
