/** The five tabs of the Settings window, in tab order. The values are the last part of the address: /settings/team. */
export const SETTINGS_TABS = ['company', 'team', 'connections', 'billing', 'setup'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tabs that are not built yet: each shows one line saying what is coming. */
export type LaterTabKey = Exclude<SettingsTab, 'company' | 'team'>;

/** True when `value` (a route parameter, so possibly undefined) names one of the tabs. */
export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab === value);
}
