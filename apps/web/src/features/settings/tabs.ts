import type { Role } from '@roofline/shared';

/** The eleven tabs of the Settings window, in tab order. The values are the last part of the address: /settings/team. */
export const SETTINGS_TABS = [
  'company',
  'team',
  'prices',
  'schedule',
  'connections',
  'storm',
  'billing',
  'setup',
  'front-desk',
  'agents',
  'profile',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** True when `value` (a route parameter, so possibly undefined) names one of the tabs. */
export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab === value);
}

/**
 * The tabs a person sees. Owners and office members see Prices, Storm, Front Desk and Agents; field reps do not.
 * While the role is not known yet, those are hidden. Everyone sees Schedule and Your profile.
 */
export function visibleTabs(role: Role | undefined): readonly SettingsTab[] {
  if (role === undefined || role === 'rep') {
    return SETTINGS_TABS.filter((tab) => tab !== 'prices' && tab !== 'storm' && tab !== 'front-desk' && tab !== 'agents');
  }
  return SETTINGS_TABS;
}
