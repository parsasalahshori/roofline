import type { CampaignStatus } from './enums.ts';

/** The setup checklist items, in the order the checklist shows them (F3 spec 5.3). */
export const SETUP_ITEM_KEYS = [
  'company_basics',
  'import_customers',
  'texting_registration',
  'invite_team',
  'payment_method',
  'prices_and_tiers',
  'connect_calendar',
  'phone_number',
  'connect_ads',
] as const;
export type SetupItemKey = (typeof SETUP_ITEM_KEYS)[number];

export const SETUP_STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'skipped'] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

/**
 * The later-spec items; each shows "Coming with [feature]" until its feature ships. 'calendar' is no
 * longer returned by any item (connect_calendar is real now) but stays so copy/setup.ts still compiles.
 */
export const COMING_WITH = ['estimator', 'calendar', 'front_desk', 'storm_scout'] as const;
export type ComingWith = (typeof COMING_WITH)[number];

/** The items that make up the progress ring in the user menu. */
export const FOUNDATION_ITEMS: readonly SetupItemKey[] = [
  'company_basics',
  'import_customers',
  'texting_registration',
  'invite_team',
  'payment_method',
];

/** The only items a user may skip. A real completion always beats a stored skip. */
export const SKIPPABLE: ReadonlySet<SetupItemKey> = new Set<SetupItemKey>([
  'import_customers',
  'invite_team',
]);

/** The raw facts the checklist rules read; the caller gathers them from the database. */
export type SetupFacts = {
  addressSaved: boolean;
  located: boolean;
  serviceArea: boolean;
  imports: { done: number; running: number };
  texting: {
    campaignStatus: CampaignStatus;
    rejectionReason: string | null;
    rejectedFields: string[];
  };
  activeMembers: number;
  pendingInvites: number;
  paymentMethod: boolean;
  ads: { active: number; pending: number };
  /** Active members with a connected calendar (a dead grant does not count). */
  calendarsConnected: number;
  /** The company has saved a pricebook and all three Good/Better/Best tier templates. */
  pricesAndTiersSaved: boolean;
  /** A forwarding test call reached the business line (company_settings.forwarding_verified_at is set). */
  forwardingVerified: boolean;
  skipped: ReadonlySet<SetupItemKey>;
};

/** One checklist row as the API returns it. */
export type SetupItemView = {
  key: SetupItemKey;
  status: SetupStatus;
  comingWith: ComingWith | null;
  skippable: boolean;
  data: Record<string, unknown>;
};

/** The whole checklist plus the Foundation progress counts. */
export type SetupView = {
  items: SetupItemView[];
  progress: { done: number; total: number };
};

const COMING_WITH_BY_KEY: Partial<Record<SetupItemKey, ComingWith>> = {
  connect_ads: 'storm_scout',
};

type Resolved = { status: SetupStatus; data: Record<string, unknown> };

/** Status and data for one item. Order of checks matters: a real done wins over a skip. */
function resolveItem(key: SetupItemKey, facts: SetupFacts): Resolved {
  switch (key) {
    case 'company_basics': {
      const data = { located: facts.located, serviceArea: facts.serviceArea };
      if (facts.located && facts.serviceArea) return { status: 'done', data };
      if (facts.addressSaved && !facts.located) return { status: 'in_progress', data };
      return { status: 'todo', data };
    }
    case 'import_customers':
      if (facts.imports.done > 0) return { status: 'done', data: {} };
      if (facts.imports.running > 0) return { status: 'in_progress', data: {} };
      if (facts.skipped.has(key)) return { status: 'skipped', data: {} };
      return { status: 'todo', data: {} };
    case 'texting_registration': {
      const { campaignStatus, rejectionReason, rejectedFields } = facts.texting;
      if (campaignStatus === 'approved') return { status: 'done', data: {} };
      if (campaignStatus === 'pending') return { status: 'waiting', data: {} };
      if (campaignStatus === 'rejected') {
        return {
          status: 'todo',
          data: { rejected: true, reason: rejectionReason, fields: [...rejectedFields] },
        };
      }
      return { status: 'todo', data: {} };
    }
    case 'invite_team':
      if (facts.activeMembers >= 2) return { status: 'done', data: {} };
      if (facts.pendingInvites > 0) return { status: 'in_progress', data: {} };
      if (facts.skipped.has(key)) return { status: 'skipped', data: {} };
      return { status: 'todo', data: {} };
    case 'payment_method':
      // Not skippable, so a stored skip for this key is deliberately ignored.
      return facts.paymentMethod ? { status: 'done', data: {} } : { status: 'todo', data: {} };
    case 'connect_ads':
      if (facts.ads.active > 0) return { status: 'done', data: {} };
      if (facts.ads.pending > 0) return { status: 'waiting', data: {} };
      return { status: 'todo', data: {} };
    case 'connect_calendar':
      // Not skippable, so a stored skip for this key is deliberately ignored.
      return facts.calendarsConnected > 0 ? { status: 'done', data: {} } : { status: 'todo', data: {} };
    case 'prices_and_tiers':
      // Not skippable, so a stored skip for this key is deliberately ignored.
      return facts.pricesAndTiersSaved ? { status: 'done', data: {} } : { status: 'todo', data: {} };
    case 'phone_number':
      // Not skippable: done only when a forwarding test has reached the business line.
      return facts.forwardingVerified ? { status: 'done', data: {} } : { status: 'todo', data: {} };
    default:
      return { status: 'todo', data: {} };
  }
}

/**
 * Derives the setup checklist from raw facts: one row per key in SETUP_ITEM_KEYS order,
 * plus progress over FOUNDATION_ITEMS (done or skipped counts as complete).
 */
export function deriveSetup(facts: SetupFacts): SetupView {
  const items: SetupItemView[] = SETUP_ITEM_KEYS.map((key) => {
    const { status, data } = resolveItem(key, facts);
    return {
      key,
      status,
      comingWith: COMING_WITH_BY_KEY[key] ?? null,
      skippable: SKIPPABLE.has(key),
      data,
    };
  });
  const done = items.filter(
    (item) =>
      FOUNDATION_ITEMS.includes(item.key) && (item.status === 'done' || item.status === 'skipped'),
  ).length;
  return { items, progress: { done, total: FOUNDATION_ITEMS.length } };
}
