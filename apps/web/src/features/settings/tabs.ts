import type { Role } from '@roofline/shared';

/** The seven tabs of the Settings window, in tab order. The values are the last part of the address: /settings/team. */
export const SETTINGS_TABS = ['company', 'team', 'prices', 'schedule', 'connections', 'billing', 'setup'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** True when `value` (a route parameter, so possibly undefined) names one of the tabs. */
export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab === value);
}

/**
 * The tabs a person sees. Owners and office members see Prices; field reps do not. While the role is not
 * known yet, Prices is hidden. Everyone sees Schedule.
 */
export function visibleTabs(role: Role | undefined): readonly SettingsTab[] {
  if (role === undefined || role === 'rep') return SETTINGS_TABS.filter((tab) => tab !== 'prices');
  return SETTINGS_TABS;
}
