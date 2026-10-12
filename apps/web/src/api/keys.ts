/*
 * Every query key in one place, so a screen that changes something can name what it made stale
 * (`invalidateQueries({ queryKey: keys.approvals })`). A key that depends on a value is a function
 * of it; the rest are plain tuples.
 */
export const keys = {
  me: ['me'] as const,
  approvals: ['approvals'] as const,
  task: (id: string) => ['task', id] as const,
  summary: ['summary'] as const,
  attention: ['attention'] as const,
  weather: ['weather'] as const,
  mapArea: ['map-area'] as const,
  pins: (bboxKey: string) => ['pins', bboxKey] as const,
  search: (q: string) => ['search', q] as const,
  company: ['company'] as const,
  team: ['team'] as const,
  texting: ['texting'] as const,
  stormSettings: ['storm-settings'] as const,
  adAccounts: ['ad-accounts'] as const,
};
