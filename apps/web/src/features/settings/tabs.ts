import type { Role } from '@roofline/shared';

/** The nine tabs of the Settings window, in tab order. The values are the last part of the address: /settings/team. */
export const SETTINGS_TABS = ['company', 'team', 'prices', 'schedule', 'connections', 'storm', 'billing', 'setup', 'agents'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** True when `value` (a route parameter, so possibly undefined) names one of the tabs. */
export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab === value);
}

/**
 * The tabs a person sees. Owners and office members see Prices, Storm and Agents; field reps do not. While the
 * role is not known yet, those are hidden. Everyone sees Schedule.
 */
export function visibleTabs(role: Role | undefined): readonly SettingsTab[] {
  if (role === undefined || role === 'rep') {
    return SETTINGS_TABS.filter((tab) => tab !== 'prices' && tab !== 'storm' && tab !== 'agents');
  }
  return SETTINGS_TABS;
}
