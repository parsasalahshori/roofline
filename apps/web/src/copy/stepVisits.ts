/** The claim packet and appointment review kits: the previews under build_claim_packet and create_appointment steps and their Edit fields. */
export const stepVisits = {
  packetBlurb: 'Builds the claim packet PDF for this job: storm evidence, measurements, inspection notes.',
  openJob: 'Open the job',
  kind: {
    adjuster: 'Adjuster visit',
    inspection: 'Inspection',
  },
  /** "Mon, Nov 2 · 9:30 AM to 10:30 AM" */
  timeLine: (day: string, from: string, to: string) => `${day} · ${from} to ${to}`,
  forMember: (name: string) => `For ${name}`,
  aTeamMember: 'a team member',
  dateLabel: 'Date',
  startLabel: 'Start time',
  endLabel: 'End time',
  noteLabel: 'Note',
  timeHelp: 'For example 9:30 AM.',
  dateError: 'Please enter the date as year-month-day, like 2026-11-02.',
  timeError: 'Please enter the time like 9:30 AM.',
  endBeforeStart: 'The end must be after the start.',
  noteTooLong: 'Please keep the note to 500 characters or fewer.',
};
