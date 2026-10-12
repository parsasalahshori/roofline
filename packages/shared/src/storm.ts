// S1 Storm Scout shared constants (Task 1). Task 4 adds the storm logic below.
export const HAIL_LEVELS_IN = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
export type HailLevelIn = (typeof HAIL_LEVELS_IN)[number];
export const STORM_STATUSES = ['provisional', 'final'] as const;
export type StormStatus = (typeof STORM_STATUSES)[number];
export const HAIL_RUN_STATUSES = ['processed', 'failed'] as const;
export type HailRunStatus = (typeof HAIL_RUN_STATUSES)[number];
export const COMPANY_STORM_STATUSES = ['new', 'planned', 'dismissed'] as const;
export type CompanyStormStatus = (typeof COMPANY_STORM_STATUSES)[number];
export const DOOR_ROUTE_STATUSES = ['ready', 'in_progress', 'done'] as const;
export type DoorRouteStatus = (typeof DOOR_ROUTE_STATUSES)[number];
export const DOOR_OUTCOMES = ['not_home', 'wants_check', 'not_interested', 'has_roofer', 'do_not_knock'] as const;
export type DoorOutcome = (typeof DOOR_OUTCOMES)[number];
export const AD_PLATFORMS = ['google', 'meta'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];
export const AD_ACCOUNT_STATUSES = ['pending', 'active', 'error', 'revoked'] as const;
export type AdAccountStatus = (typeof AD_ACCOUNT_STATUSES)[number];
export const AD_CAMPAIGN_STATUSES = ['creating', 'paused', 'active', 'ended', 'failed'] as const;
export type AdCampaignStatus = (typeof AD_CAMPAIGN_STATUSES)[number];
/** Who paused a campaign: Roofline itself (the 95% pause, or a confirmed-off failed row) or the ad platform. */
export const AD_PAUSED_BY = ['roofline', 'platform'] as const;
export type AdPausedBy = (typeof AD_PAUSED_BY)[number];
export const AD_ERROR_KINDS = ['policy', 'payment', 'access', 'targeting', 'other'] as const;
export type AdErrorKind = (typeof AD_ERROR_KINDS)[number];
export const EMAIL_OPT_OUT_SOURCES = ['link', 'one_click', 'complaint', 'manual'] as const;
export type EmailOptOutSource = (typeof EMAIL_OPT_OUT_SOURCES)[number];

// Task 4 logic lives in two files (one owner each); this file re-exports them so callers import from storm.ts.
export * from './storm-templates.ts';
export * from './storm-math.ts';
