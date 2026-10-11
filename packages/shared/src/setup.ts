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
