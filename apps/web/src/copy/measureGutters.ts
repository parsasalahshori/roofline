/** Words for Measure gutters (features/measure/gutters): the eaves on the map, the scan, the card, Adjust and the quote. */
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const ft = (n: number) => `${Math.round(n).toLocaleString('en-US')} ft`;
const sizeName = (size: '5in' | '6in') => (size === '5in' ? '5 in' : '6 in');

export const measureGutters = {
  title: 'Measure',
  subtitle: 'Gutter runs and quotes from the roof',
  switchGutters: 'Gutters',

  steps: { label: 'Steps', requests: 'Requests', gutters: 'Gutters', quote: 'Quote' },
  loading: 'Loading the gutters…',
  loadFailed: 'We could not work out gutters for this roof.',
  noRoof: 'This measurement has no roof drawn yet. Measure the roof first, then come back for its gutters.',

  // The map
  mapLabel: 'Aerial photo with the gutter runs drawn on the eaves',
  measuringChip: 'Estimator is measuring',
  fromRoofChip: 'Worked out from the roof measurement',
  legendLabel: 'Map key',
  legendGutter: 'Gutter',
  legendLeftOut: 'Left out',
  legendRake: 'Rake, no gutter',
  legendDownspout: 'Downspout',
  runLength: (lengthFt: number) => ft(lengthFt),
  runButton: (side: string, lengthFt: number, out: boolean) =>
    out ? `${side} run, ${ft(lengthFt)}, left out. Put it back` : `${side} run, ${ft(lengthFt)}. Leave it out`,

  // The scan
  scanIntroName: 'Estimator',
  scanIntroRest: ' lays gutters along this roof’s eaves, places downspouts and prices them.',
  scanButton: 'Measure gutters',
  stage: { finding: 'Finding the eaves', tracing: 'Measuring gutter runs', reading: 'Placing downspouts', pricing: 'Pricing' },
  measuredBy: 'Measured by Estimator',

  // The card
  cardLabel: 'Gutter measurements',
  gutterLabel: 'Seamless gutter',
  gutterUnit: 'ft',
  runsLine: (runs: number, corners: number) => `${plural(runs, 'run', 'runs')}, ${plural(corners, 'corner', 'corners')}`,
  downspoutsCell: 'Downspouts',
  downspoutsValue: (n: number, totalFt: number) => `${n} · ${ft(totalFt)}`,
  cornersCell: 'Corners',
  cornersValue: (inside: number, outside: number) => `${inside} in · ${outside} out`,
  sizeCell: 'Size',
  sizeValue: (size: '5in' | '6in', downspout: string) => `${sizeName(size)} K-style · ${downspout}`,
  heightCell: 'Eave height',
  heightValue: (heightFt: number, floors: number) => `${ft(heightFt)} · ${plural(floors, 'floor', 'floors')}`,
  heightSource: {
    google: 'From the aerial height map of the house',
    floors: 'Floors times 10 ft (no height data)',
    assumed: 'One floor assumed (no height data)',
  },
  reasonLabel: 'Why this size',
  rainNote: (inPerHr: number) => `Sized for ${inPerHr} in/hr, a 10-year five-minute Arkansas downpour (NOAA Atlas 14)`,
  porchNote: 'Porch and patio roofs have their own runs, one floor up.',
  noRuns: 'No eaves on this roof take a gutter.',
  saveFailed: 'Your gutter changes did not save. Try again.',
  adjust: 'Adjust',
  done: 'Done',
  estimateTag: 'Estimate',

  // Adjust
  runsTitle: 'Gutter runs',
  runsHint: 'Tap a run on the map or here to leave it out or put it back.',
  runName: (index: number, side: string, porch: boolean) => `${index}. ${side}${porch ? ' porch' : ''}`,
  runDetail: (lengthFt: number, drainsSqFt: number) => `${ft(lengthFt)}, drains ${drainsSqFt.toLocaleString('en-US')} sq ft`,
  downspoutsFor: (name: string) => `Downspouts on ${name}`,
  fewer: (name: string) => `One fewer downspout on ${name}`,
  more: (name: string) => `One more downspout on ${name}`,
  minus: '−',
  plus: '+',
  sizeTitle: 'Gutter size',
  sizeAuto: (recommended: '5in' | '6in') => `Recommended (${sizeName(recommended)})`,
  size5: '5 in',
  size6: '6 in',
  side: {
    north: 'North',
    northeast: 'Northeast',
    east: 'East',
    southeast: 'Southeast',
    south: 'South',
    southwest: 'Southwest',
    west: 'West',
    northwest: 'Northwest',
  },

  // The quote
  quoteTitle: 'Gutter quote',
  quoteLine: (gutterFt: number, downspouts: number) => `${ft(gutterFt)} of gutter, ${plural(downspouts, 'downspout', 'downspouts')}`,
  quoteGroup: (tier: string) => `${tier} gutters`,
  quoteLineName: {
    gutter: 'Seamless gutter, installed',
    downspout: 'Downspouts',
    corner: 'Mitered corners',
    guard: 'Gutter guards',
  },
  quoteLineQty: (quantity: number, unit: 'ft' | 'each', unitPrice: string) =>
    unit === 'ft' ? `${ft(quantity)} × ${unitPrice}` : `${quantity} × ${unitPrice}`,
  belowRecommended: 'Smaller than recommended for this roof',
  noQuote: 'No gutter runs to price.',
  noMoney: 'Prices show for the owner and office.',
  accessories: (endCaps: number, hangers: number, outlets: number, elbows: number) =>
    `Includes ${plural(endCaps, 'end cap', 'end caps')}, ${plural(hangers, 'hanger', 'hangers')}, ${plural(outlets, 'outlet', 'outlets')} and ${plural(elbows, 'elbow', 'elbows')}`,
  send: 'Send gutter proposal',
  sendNext: 'Sending gutter proposals comes next. For now, share the price from this screen.',
};
