/** The words on and around the map. */
export const mapCopy = {
  /** The accessible name of the map region. */
  label: 'Map of your customers and jobs',
  /** The satellite switch. Its pressed state says whether satellite is on. */
  satellite: 'Satellite view',
  /** The button on a picked pin that opens its customer or job. */
  open: 'Open',
  /** Shown once, over the map, when its style, a source or a tile fails to load. */
  error: 'The map is having trouble loading. Your work is safe.',
  /** The legend title and the name of its region. */
  hailLegend: 'Radar-estimated hail',
  /** The visible title of the map's hail legend chips. */
  hailLegendTitle: "Last night's hail",
  /** The everyday object each legend level is named for, level 1 first; its size is `hailSizeLevels`. */
  hailSizeNames: ['Penny', 'Quarter', 'Ping-pong', 'Golf ball', 'Tennis ball'] as const,
  /** The hail layer switch. Its pressed state says whether the layer is on. */
  hailLayer: 'Hail layer',
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
