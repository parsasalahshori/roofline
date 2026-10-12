/** The move-an-install review kit: the preview under a move_appointment step and its Edit field. */
export const stepMoves = {
  /** "Move the install to Mon, Nov 2" */
  moveTo: (day: string) => `Move the install to ${day}`,
  /** "Move the install to Mon, Nov 2, 9:30 AM to 10:30 AM" */
  moveToAt: (day: string, from: string, to: string) => `Move the install to ${day}, ${from} to ${to}`,
  fallbackTitle: 'Move an install',
  /** "Now on Thu, Oct 29": the day the install is booked for today. */
  from: (day: string) => `Now on ${day}`,
  forMember: (name: string) => `For ${name}`,
  aTeamMember: 'a team member',
  dateLabel: 'New day',
  dateHelp: 'Write the day as year-month-day, like 2026-11-02.',
  dateError: 'Please write the day as year-month-day, like 2026-11-02.',
  pastError: 'Please pick today or a later day.',
};
