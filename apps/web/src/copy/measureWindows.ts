/** Words for Measure windows (features/measure/windows): the photo of the front, the scan, the card and the quote. */
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const inches = (n: number) => `${Math.round(n)}`;

export const measureWindows = {
  title: 'Measure',
  subtitle: 'Window counts and quotes in seconds',
  switchLabel: 'What to measure',
  switchRoof: 'Roof',
  switchWindows: 'Windows',

  // The left column: an address to measure
  startTitle: 'Measure windows',
  startSubtitle: 'Type an address. Estimator works the windows out from the house’s walls.',
  addressLabel: 'Address',
  addressPlaceholder: '12 Elm St, Omaha, NE',
  measure: 'Measure this address',
  measuring: 'Finding the house',
  measureFailed: 'We could not measure the windows at that address.',
  opened: 'Open now',
  pickAddress: 'Type an address to measure its windows.',
  loading: 'Loading the windows…',
  loadFailed: 'We could not load these windows.',

  // The phone's steps
  steps: { label: 'Steps', start: 'Address', windows: 'Windows', quote: 'Quote' },

  // The photo and what goes over it
  photoLabel: 'Street-level photo of the front of the house',
  photoAlt: (address: string) => `The front of ${address}`,
  photoPick: 'Photo',
  photoNumber: (n: number, total: number) => `Photo ${n} of ${total}`,
  photoFailed: 'The photo did not load.',
  noPhoto: 'No street-level photo of this house',
  imageryCaptured: (when: string) => `Street-level imagery captured ${when}`,
  imageryPlain: 'Street-level imagery',
  measuringChip: 'Estimator is measuring',
  wallsTitle: 'Walls',
  wallsPlanLabel: (perimeterFt: number, frontFt: number | null) =>
    frontFt === null ? `Plan of the walls, ${Math.round(perimeterFt)} ft around` : `Plan of the walls, ${Math.round(perimeterFt)} ft around, ${Math.round(frontFt)} ft along the front`,
  wallsAround: (ft: number) => `${Math.round(ft).toLocaleString()} ft around`,
  wallsFront: (ft: number) => `front ${Math.round(ft)} ft`,
  wallsHigh: (ft: number) => `${Math.round(ft)} ft high`,
  floors: (n: number) => plural(n, 'floor', 'floors'),

  // The front wall drawn on the photo
  wallFit: {
    good: 'Walls line up with the photo',
    off: 'Walls don\u2019t line up: drag the corners onto the house',
    unknown: 'Can\u2019t check the walls in this photo',
  },
  wallHeights: (fromHeights: number, fromPhoto: number) => `Wall height ${fromHeights.toFixed(1)} ft from heights, ${fromPhoto.toFixed(1)} ft from photo`,
  wallOutlineLabel: 'The front wall from the outline, drawn on the photo',
  wallCorner: { bl: 'bottom left', br: 'bottom right', tr: 'top right', tl: 'top left' },
  wallCornerLabel: (corner: string) => `Front wall corner, ${corner}. Drag it onto the house, or use the arrow keys.`,
  wallTitle: 'Front wall',
  wallHint: 'If the dashed wall does not sit on the house, drag its four corners onto the house\u2019s corners at the ground and the eaves.',
  wallEdit: 'Move wall corners',
  wallEditStop: 'Done moving corners',
  wallReset: 'Put the corners back',

  // The scan
  scanIntroName: 'Estimator',
  scanIntroRest: ' works out every window from the walls of this house, then prices Good, Better, Best.',
  scanButton: 'Measure windows',
  stage: {
    finding: 'Finding the house',
    tracing: (perimeterFt: number | null) => (perimeterFt === null ? 'Tracing the walls' : `Tracing ${Math.round(perimeterFt).toLocaleString()} ft of wall`),
    reading: 'Reading wall heights and floors',
    pricing: 'Counting windows and pricing Good, Better, Best',
  },
  measuredBy: 'Measured by Estimator',

  // Each window on the photo
  size: (w: number, h: number) => `${inches(w)} × ${inches(h)} in`,
  sizing: 'Sizing…',
  autoFound: 'Auto-found',
  windowLabel: (n: number, size: string, inQuote: boolean) => `Window ${n}, ${size}, ${inQuote ? 'in the quote' : 'left out'}`,
  markedLabel: (n: number, size: string) => `Marked window ${n}, ${size}`,
  leftOut: 'Left out',

  // The card
  statsLabel: 'Window measurements',
  about: 'About',
  windowsUnit: (n: number) => (n === 1 ? 'window' : 'windows'),
  fromWalls: 'estimated from the walls',
  toReplace: 'windows to replace',
  measuredAndEstimated: (measured: number, estimated: number) =>
    `${plural(measured, 'window', 'windows')} measured on the front, ${plural(estimated, 'window', 'windows')} estimated on the sides and back`,
  measuredOnly: (measured: number) => `${plural(measured, 'window', 'windows')} measured on the front`,
  wallsBasis: (perimeterFt: number, heightFt: number | null, floors: number | null, areaSqFt: number | null) =>
    [
      `${Math.round(perimeterFt).toLocaleString()} ft of wall`,
      heightFt !== null ? `${Math.round(heightFt)} ft high` : null,
      floors !== null ? plural(floors, 'floor', 'floors') : null,
      areaSqFt !== null ? `${Math.round(areaSqFt).toLocaleString()} sq ft of wall` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(', '),
  basisLabel: 'How it was worked out',
  tableLabel: 'Windows by size',
  sizeHead: 'Size',
  measuredHead: 'Measured',
  estimatedHead: 'Estimated',
  totalHead: 'Total',
  estimatedAll: 'All sides (estimated)',
  estimatedSidesBack: 'Sides and back (estimated)',
  sizeClass: { small: 'Small', standard: 'Standard', large: 'Large', picture: 'Picture' },
  sizeClassHint: { small: '\u2264 72 in', standard: '73\u2013101 in', large: '102\u2013120 in', picture: '> 120 in' },
  sizeClassRule: 'Sizes by united inches: width plus height.',
  floorsCell: 'Floors',
  imageryCell: 'Photo taken',
  foundByCell: 'Front windows',
  foundBy: { none: 'Not marked yet', marked: 'Marked by you', detector: 'Auto-found', standIn: 'Demo detector' },
  unknown: '—',
  estimateTag: 'Estimate',
  manualTag: 'Typed in',
  adjust: 'Adjust',
  done: 'Done',

  // Adjust
  markTitle: 'Mark windows on the photo',
  markHint: 'Press on the photo and drag round a window. Drag a corner or an edge to resize it. Select one and press Delete to remove it.',
  markStart: 'Mark windows',
  markStop: 'Stop marking',
  markOn: 'Marking: drag round each window on the front',
  undo: 'Undo',
  remove: 'Remove',
  removeLabel: (n: number) => `Remove marked window ${n}`,
  handleLabel: (edge: string) => `Resize from the ${edge}`,
  handles: { n: 'top', s: 'bottom', e: 'right', w: 'left', ne: 'top right', nw: 'top left', se: 'bottom right', sw: 'bottom left' },
  keysHint: 'Arrow keys move the selected window; with Shift they resize it.',
  estimatedTitle: 'Sides and back',
  estimatedAllTitle: 'Every side',
  estimatedHint: 'Set how many windows of each size the house has where the photo cannot see.',
  stepDown: (cls: string) => `One fewer ${cls.toLowerCase()} window`,
  stepUp: (cls: string) => `One more ${cls.toLowerCase()} window`,
  stepValue: (cls: string) => `${cls} windows, estimated`,
  minus: '\u2212',
  plus: '+',
  resetCounts: 'Back to the estimate',
  measuredTitle: 'Front windows',
  measuredHint: 'Tap a window on the photo, or here, to leave it out of the quote.',
  includeWindow: (n: number) => `Window ${n}`,
  saving: 'Saving…',
  saveFailed: 'We could not save that change. Try again.',

  // Why a person should check the windows before pricing them
  needsReview: 'Check these windows before you price them.',
  reviewReason: {
    'stand-in-detector': 'Demo detector: these windows are made up. Add a detector key for real windows.',
    'front-only': 'Only the front was seen. The sides and back are estimated.',
    'low-confidence': 'Some windows were hard to make out on the photo. Check them.',
    'old-imagery': 'The street-level photo is more than 5 years old.',
    'partly-hidden': 'Part of the front is hidden on the photo.',
    'estimated-from-size': 'Estimated from the house’s size. Mark the front windows on the photo for real sizes.',
    'walls-unconfirmed': 'The front wall drawn from the outline does not line up with the house on the photo. Drag its corners onto the house under Adjust, or check the wall length and height.',
  },
  standIn: 'Demo detector: these windows are made up. Add a detector key for real windows.',

  // Why no window could be seen on the photo
  missing: {
    'no-street-view': 'No street-level photo near this house, so no window could be marked. The quote uses the estimate from the walls.',
    'house-blurred': 'The owner had this house blurred in street-level imagery, so no window could be marked. The quote uses the estimate from the walls.',
    'facade-hidden': 'Trees, fences or cars hide the front of the house on the photo. The quote uses the estimate from the walls.',
    'no-footprint': 'No building outline was found for this address, so the walls could not be measured. Type in the window counts under Adjust.',
    'detector-unconfigured': 'No window finder is set up. Mark the front windows on the photo, or use the estimate.',
    'detector-error': 'The window finder did not answer. Mark the front windows on the photo, or use the estimate.',
  },
  noEstimate: 'No estimate for this house. Type in the window counts under Adjust.',

  // The quote
  quoteTitle: 'Window quote',
  quoteLine: (windows: number, measured: number) =>
    measured === 0 ? `${plural(windows, 'window', 'windows')}, all estimated` : `${plural(windows, 'window', 'windows')}, ${measured.toLocaleString()} measured`,
  quoteGroup: (tier: string) => `Windows for ${tier}`,
  quoteLineName: (cls: string) => `${cls} windows`,
  quoteLineQty: (count: number, unit: string) => `${count} × ${unit}`,
  noWindows: 'No windows to price yet.',
  quoteFailed: 'We could not price these windows.',
  quoteLoading: 'Pricing the windows',
  send: 'Send proposal',
  sendNext: 'Window proposals come next. For now, share this quote by hand.',
} as const;
