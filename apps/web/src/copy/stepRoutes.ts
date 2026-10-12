/** The review kit's words for a build_routes step (the door-knock plan): its preview and its Edit fields. */
export const stepRoutes = {
  /** Under the preview's title: the crew plans these knocks, and nothing goes out to a customer. */
  internalNote: 'Your crew plans these knocks. Nothing goes out to a customer.',
  /** The Edit field that picks the reps. */
  repsLabel: 'Reps on these routes',
  /** The Edit field for the most doors. */
  doorsLabel: 'Most doors to plan',
  /** The door cap, shown under the routes. */
  doorsCap: (n: number): string => `Up to ${n} doors`,
  /** A rep whose name is not known (the team is loading, or they left the team): by position, from 1. */
  repFallback: (i: number): string => `Rep ${i + 1}`,
  /** Shown on the reps field when none is picked. */
  pickOneRep: 'Please pick at least one rep.',
} as const;
