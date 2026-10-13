/** The home page's "Signed this month" card. */

/** Whole dollars, as the card shows every amount. */
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** 418200 cents reads $4,182. */
export const signedMoney = (cents: number) => dollars.format(cents / 100);

const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** 'Oct 12' from a 'YYYY-MM-DD' week start, with no time zone shifting. */
export function signedWeekLabel(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  if (!y || !m || !d) return weekStart;
  return monthDay.format(new Date(Date.UTC(y, m - 1, d)));
}

export const liftSigned = {
  title: 'Signed this month',
  /** The chip: 96 reads "96% of goal". */
  percentOfGoal: (percent: number) => `${percent}% of goal`,
  goal: (goalCents: number) => `Goal ${signedMoney(goalCents)}`,
  chartLabel: 'Signed each week, last 12 weeks',
  chartWeek: 'Week of',
  chartTotal: 'Signed',
  axisStart: '12 weeks ago',
  axisEnd: 'This week',
  openPipeline: 'Open pipeline',
  loading: 'Loading signed proposals',
  loadFailed: "We couldn't load this. Try again in a moment.",
  /** Shown when nothing is signed this month and no week in the last twelve has a signing. */
  empty: 'Nothing signed yet. Signed proposals will show here.',
};
