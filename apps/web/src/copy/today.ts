export const today = {
  greeting: (part: 'morning' | 'afternoon' | 'evening', firstName: string) =>
    firstName ? `Good ${part}, ${firstName}` : `Good ${part}`,
  needYourOk: 'Need your OK',
  nothingNeedsYou: 'Nothing needs your OK right now.',
  seeAll: (n: number) => `See all ${n}`,
  appointments: "Today's appointments",
  noAppointments: 'No appointments yet. Your calendar is coming soon.',
  draftsLabel: 'Plans waiting for your OK',
} as const;
