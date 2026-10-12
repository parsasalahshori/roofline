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
  /** The hail layer switch. Its pressed state says whether the layer is on. */
  hailLayer: 'Hail layer',
  /** The hail size of each legend level, level 1 first. */
  hailSizeLevels: ['0.75 in', '1.25 in', '1.75 in', '2.5 in', '3 in or more'] as const,
  /** Read aloud when the pins change. */
  summary: (customers: number, jobs: number): string =>
    `Map showing ${customers} ${customers === 1 ? 'customer' : 'customers'} and ${jobs} open ${jobs === 1 ? 'job' : 'jobs'}.`,
  /** Read aloud when the server has grouped the pins into areas; `total` is how many places the groups hold. */
  summaryClusters: (total: number): string =>
    `Map showing ${total} ${total === 1 ? 'place' : 'places'}, grouped by area.`,
} as const;
