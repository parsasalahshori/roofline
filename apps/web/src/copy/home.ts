/** The map home page: the greeting card, its briefing and buttons, and the storm toast. */

/** One run of the briefing: `bold` runs carry the numbers the reader should catch first. */
export type BriefingPart = { text: string; bold?: boolean };

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export const home = {
  /** "Good morning, Dale." */
  greeting: (part: 'morning' | 'afternoon' | 'evening', firstName: string) =>
    firstName ? `Good ${part}, ${firstName}.` : `Good ${part}.`,
  openStormReport: 'Open storm report',
  fixRainDay: 'Fix the rain day',
  allQuiet: 'Nothing needs you right now. Your agents are keeping watch.',
  loading: 'Loading your briefing',

  /**
   * The briefing, from what the company really has: the latest storm (inches, homes in the path), the
   * inspections its plan booked, and the installs the coming forecast puts at risk. A sentence is left out
   * when its number is not there. `when` is "overnight" for a storm from today, else "on Tuesday".
   */
  briefing: (facts: {
    storm: { maxIn: number; homesHit: number; when: string } | null;
    inspectionsBooked: number;
    atRisk: number;
    riskDay: string | null;
  }): BriefingPart[] => {
    const parts: BriefingPart[] = [];
    const { storm } = facts;
    if (storm) {
      parts.push({ text: `Hail up to ${Number(storm.maxIn.toFixed(2))} inches crossed the county ${storm.when}. ` });
      if (storm.homesHit > 0) {
        parts.push({ text: `${storm.homesHit} ${plural(storm.homesHit, 'home', 'homes')}`, bold: true });
        parts.push({ text: ` ${plural(storm.homesHit, 'was', 'were')} in the path. ` });
      }
    }
    if (facts.inspectionsBooked > 0) {
      parts.push({ text: 'Front Desk has booked ' });
      parts.push({ text: `${facts.inspectionsBooked} ${plural(facts.inspectionsBooked, 'inspection', 'inspections')}`, bold: true });
      parts.push({ text: '. ' });
    }
    if (facts.atRisk > 0 && facts.riskDay) {
      parts.push({ text: `${facts.riskDay}'s storms put ` });
      parts.push({ text: `${facts.atRisk} ${plural(facts.atRisk, 'tear-off', 'tear-offs')}`, bold: true });
      parts.push({ text: ' at risk.' });
    }
    const last = parts[parts.length - 1];
    if (last) last.text = last.text.trimEnd();
    return parts;
  },

  /** The storm's own day against today: "overnight" or "on Monday". */
  stormWhen: (sameDay: boolean, weekday: string) => (sameDay ? 'overnight' : `on ${weekday}`),

  // The storm toast
  toastApp: 'Storm Scout',
  toastNow: 'now',
  toastTitle: 'Hail report is ready',
  toastBody: (homes: number, when: string) =>
    `${homes} ${plural(homes, 'roof was', 'roofs were')} in ${when === 'overnight' ? "last night's" : 'the'} hail path.`,
  toastReview: 'Review the storm',
  toastDismiss: 'Dismiss',
} as const;
