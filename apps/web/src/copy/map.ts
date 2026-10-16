/** The words on and around the map. */
export const mapCopy = {
  /** The accessible name of the map region. */
  label: 'Map of your customers and jobs',
  /** The three switches over the map. Each one's pressed state says whether its layer is on. */
  layersLabel: 'Map layers',
  jobsLayer: 'Jobs',
  satellite: 'Satellite',
  /** The buttons on a picked pin: open its job or customer, and get driving directions to its address. */
  openJob: 'Open job',
  openCustomer: 'Open customer',
  directions: 'Directions',
  /** Shown once, over the map, when its style, a source or a tile fails to load. */
  error: 'The map is having trouble loading. Your work is safe.',
  /** The legend title and the name of its region. */
  hailLegend: 'Radar-estimated hail',
  /** The title of the hail legend, read by a screen reader (the chips carry the meaning for everyone else). */
  hailLegendTitle: 'Hail size',
  /** The pin legend's name, and the words beside each colour (a customer is someone with no open job). */
  pinLegend: 'What the pins mean',
  pinNames: { lead: 'Lead', inspection: 'Inspection', proposal: 'Proposal', won: 'Won', customer: 'Customer' } as const,
  /** The everyday object each legend level is named for, level 1 first; its size is `hailSizeLevels`. */
  hailSizeNames: ['Penny', 'Quarter', 'Ping-pong', 'Golf ball', 'Tennis ball'] as const,
  hailLayer: 'Hail',
  /** The hail size of each legend level, level 1 first. */
  hailSizeLevels: ['0.75 in', '1.25 in', '1.75 in', '2.5 in', '3 in or more'] as const,
  /** The card a click on a roof opens (owner and office only). */
  roofTitle: 'This roof',
  /** Under the title: the address is asked for when the estimate opens. */
  roofHint: 'Address on next step',
  /** The card's main button: measure this roof and start an estimate. */
  estimateRoof: 'Estimate this roof',
  /** A quiet toast when a click lands where there is no building outline. */
  noBuilding: 'No building here.',
  /** Over the map while a click looks for its roof in an area whose outlines are still loading. */
  findingRoof: 'Finding the roof outline for this area (first time only, about 30 seconds)',
  /** A toast when finding the building or starting the estimate fails. */
  roofFailed: 'Could not start an estimate for this roof. Try again.',
  /** Read aloud when a roof is picked. */
  roofPicked: 'Roof selected.',
  /** Read aloud when the pins change. */
  summary: (customers: number, jobs: number): string =>
    `Map showing ${customers} ${customers === 1 ? 'customer' : 'customers'} and ${jobs} open ${jobs === 1 ? 'job' : 'jobs'}.`,
  /** Read aloud when the server has grouped the pins into areas; `total` is how many places the groups hold. */
  summaryClusters: (total: number): string =>
    `Map showing ${total} ${total === 1 ? 'place' : 'places'}, grouped by area.`,
} as const;
