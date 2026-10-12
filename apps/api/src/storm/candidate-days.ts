/**
 * The convective days storm matching looks at: the day `now` falls on (UTC) and the three before it,
 * newest first, as 'YYYY-MM-DD'. A storm still growing or just made final is inside this window.
 * Shared by the storm-match schedule (which companies to queue) and matchCompany (which storms to read).
 */
export function candidateDays(now: Date): string[] {
  const days: string[] = [];
  for (let back = 0; back < 4; back += 1) {
    days.push(new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}
