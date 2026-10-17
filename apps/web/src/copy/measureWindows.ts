/** Words for Measure windows (features/measure/windows): the photo of the front, the scan, the card and the quote. */
import type { SizeCopy } from '@roofline/ui';

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const inches = (n: number) => `${Math.round(n)}`;
/** "2 floors (from the height map)", "1.5 floors (from the height map)", "1 floor (assumed: no height data)". */
const measureWindowsFloors = (floors: number, from: 'height-map' | 'photo' | 'assumed') =>
  `${floors === 1 ? '1 floor' : `${floors} floors`} (${from === 'assumed' ? 'assumed: no height data' : from === 'photo' ? 'from the photo' : 'from the height map'})`;

/** The words a size readout speaks and names its method with (the kit holds no words of its own). */
export const sizeCopy: SizeCopy = {
  by: 'by',
  inches: 'inches',
  about: 'about',
  plusMinus: 'plus or minus',
  methods: { lidar: 'LiDAR', sheet: 'Sheet photo', room: 'Room scan', walls: 'From walls' },
};

export const measureWindows = {
  title: 'Measure',
  subtitle: 'Window counts and quotes in seconds',
  switchLabel: 'What to measure',
  switchRoof: 'Roof',
  switchWindows: 'Windows',


  // The head of the page: the street is the title, and this is the line under it
  headDot: '\u00b7',
  headFloors: (floors: number) => (floors === 1 ? '1 floor' : `${floors} floors`),
  headWall: (ft: number) => `${Math.round(ft).toLocaleString()} ft of wall`,
  headMeasured: (seconds: number) => `measured by Estimator in ${seconds.toFixed(1)} s`,
  replayScan: 'Run the scan again',

  // The front elevation: a drawing of the front from what was measured
  elevation: {
    title: 'Front elevation',
    label: (windows: number) => `Front elevation with ${windows === 1 ? '1 window' : `${windows} windows`} numbered`,
    feet: (ft: number) => `${ft} ft`,
    inches: (fraction: string) => `${fraction} in`,
    more: (n: number) => `+${n} more`,
    noWalls: 'The walls of this house are not known yet, so there is nothing to draw.',
    views: { label: 'View', drawing: 'Drawing', photo: 'Photo', plan: 'Plan' },
    photoWhen: (when: string) => `Photo \u00b7 ${when}`,
    scale: 'Sizes are to scale. Where each window sits along the wall is not known.',
    measuringTitle: 'Measuring',
  },

  // How precisely each window is measured: the three rungs under every result
  ladder: {
    label: 'How precisely the windows are measured',
    estimate: 'Estimate from walls',
    /** The same rung on a phone, where the tile is too narrow for the long name (the phone mockup says Estimate) */
    estimatePhone: 'Estimate',
    quote: 'Quote-grade',
    order: 'Order-grade',
    estimateNote: 'Count \u00b12 \u00b7 quote only',
    quoteNote: 'Room scan \u00b7 size \u00b11 in',
    orderNote: 'LiDAR or sheet photo \u00b7 \u00b11/8 in',
    of: (total: number) => ` of ${total}`,
  },

  // The windows table
  table: {
    label: 'Windows',
    columns: { tag: '#', location: 'Location', sizeClass: 'Size class', size: 'W \u00d7 H (in)', method: 'Method', status: 'Status' },
    methods: {
      lidar: 'LiDAR',
      ar: 'Phone AR',
      sheet: 'Sheet photo',
      paper: 'Paper photo',
      hand: 'By hand',
      room: 'Room scan',
      street: 'Street photo',
      walls: 'From walls',
    },
    status: { ready: 'Order-ready', remeasure: 'Re-measure', quote: 'Quote-grade', estimate: 'Estimate', out: 'Left out' },
    selectRow: (tag: string, name: string) => `${tag}, ${name}`,
    estimateRowName: (count: number, cls: string) => (count === 1 ? `${cls} window, estimated` : `${count} ${cls.toLowerCase()} windows, estimated`),
    streetName: (floor: number) => (floor > 1 ? `Front, floor ${floor}` : 'Front'),
    united: (range: string) => `${range} united`,
    empty: 'No windows to list yet.',
    summary: (windows: number, measured: number) =>
      measured === 0 ? `${plural(windows, 'window', 'windows')}, all estimated` : `${plural(windows, 'window', 'windows')} \u00b7 ${measured.toLocaleString()} measured`,
    summaryFromPhotos: (windows: number) => `${plural(windows, 'window', 'windows')}, counted from photos`,
    summaryRange: (low: number, high: number, likely: number) => `About ${low}\u2060\u2013\u2060${high} windows, most likely ${likely}`,
    adjustCounts: 'Adjust counts',
    countsLabel: 'Estimated window counts',
    reasonsLabel: 'Why measure again',
    reasonUnclear: 'A photo of this window was steep or unclear: check its corners, or measure it by hand.',
    // The other reason already says to measure by hand: this one asks for the photo
    reasonDoubt: (inches: string) => `The size could be off by ${inches} in, more than a factory order allows. Take another photo.`,
    streetDetail: 'Sized from the street photo, so it is good for a quote, not an order.',
    streetWas: (w: number, h: number) => `It was ${inches(w)} \u00d7 ${inches(h)} in before the door ruler.`,
    fine: 'Measured on site. Good to order from.',
    estimateDetail: (cls: string, covers: 'all-sides' | 'sides-and-back') =>
      `Worked out from the walls of ${covers === 'all-sides' ? 'every side' : 'the sides and back'}, not measured. Measure a window to replace a guess with a size, or adjust the counts below.`,
    measureOne: 'Add on-site photos',
    measureAgain: 'Measure again',
    sizeRule: 'Sizes by united inches: width plus height.',
  },

  // The left column: an address to measure
  startTitle: 'Measure windows',
  startSubtitle: 'Type an address. Estimator works the windows out from the house’s walls.',
  startSteps: [
    'Type an address. Estimator finds the house and counts its windows from the walls.',
    'Add on-site photos for exact sizes: LiDAR, or the measuring sheet.',
    'Quote Good, Better and Best, or order from the factory.',
  ],
  addressLabel: 'Address',
  /** An address as an example, in the company's own town when it has one: "12 Elm St, Little Rock, AR". */
  addressPlaceholder: (city: string | null, state: string | null): string => {
    const place = [city, state].filter((part): part is string => part !== null && part.trim() !== '').map((part) => part.trim());
    return place.length === 0 ? '12 Elm St' : `12 Elm St, ${place.join(', ')}`;
  },
  measure: 'Measure this address',
  measuring: 'Finding the house',
  measureFailed: 'We could not measure the windows at that address.',
  opened: 'Open now',
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
  /** The street photo without the Street View tools: a check that it is the house, with the photo's date. */
  rightHouse: (when: string | null) => (when === null ? 'Is this the right house?' : `Is this the right house? Photo from ${when}`),
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
    unknown: 'Can\u2019t confirm the walls in this photo',
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

  // Adjust's view of the photo: the whole photo, zoom and pan
  zoomLabel: 'Zoom',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomWall: 'Zoom to wall',
  zoomWhole: 'Whole photo',
  zoomHint: 'Pinch, scroll or use + and \u2212 to zoom. Drag the photo to move it, or with two fingers while marking.',

  // A door as a ruler
  rulerTitle: 'Door as a ruler',
  rulerHint:
    'Mark a door of known size and every window you mark on this photo is sized to match it. Use the garage door when the house has one: it sits flush with its wall. A front door is often set back in a porch or entry, which makes the windows come out too big.',
  rulerKindLabel: 'Door',
  rulerKind: { 'garage-door': 'Garage door', 'front-door': 'Front door', custom: 'Other size' },
  rulerSizeLabel: 'Size',
  rulerCustomWidth: 'Width (in)',
  rulerCustomHeight: 'Height (in)',
  rulerMark: 'Mark the door',
  rulerMarkAgain: 'Mark the door again',
  rulerMarkStop: 'Stop marking the door',
  rulerOn: 'Drag round the door, from its frame\u2019s edges',
  rulerRemove: 'Stop using the ruler',
  rulerBoxLabel: (kind: string, size: string) => `Ruler: ${kind.toLowerCase()}, ${size}`,
  rulerUsed: (kind: string, size: string) => `Sized using the ${kind.toLowerCase()} as a ruler (${size})`,
  rulerAssumption: (before: number, after: number) =>
    `Taken as flush with the wall: the camera is ${after.toFixed(1)} m from the door, not ${before.toFixed(1)} m as drawn from the outline.`,
  rulerCheck: 'The door\u2019s width and height disagree. Check the box sits on the door\u2019s edges and the size is right.',
  rulerFrontDoorNote: 'A front door set back in a porch reads too big. If the house has a garage door, use it instead.',
  rulerPending: 'Sizing with the ruler\u2026',
  wasSize: (w: number, h: number) => `was ${inches(w)} × ${inches(h)} in`,

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
  autoFoundShort: 'Auto',
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
  /**
   * How the estimate was worked out, each fact once: "220 ft of wall, 2 floors (from the height map), eaves 19 ft up.
   * 40 ft of a low wing (likely a garage or porch) left out. About 17 windows."
   */
  wallsBasis: (b: {
    perimeterFt: number;
    wallHeightFt: number | null;
    floors: number | null;
    floorsFrom: 'height-map' | 'photo' | 'assumed';
    lowWingFt: number;
    outlineFrom: 'footprint' | 'google-roof';
    windows: number | null;
    range: { low: number; high: number } | null;
    covers: 'all-sides' | 'sides-and-back';
  }) =>
    [
      [
        `${Math.round(b.perimeterFt).toLocaleString()} ft of wall`,
        b.floors !== null ? measureWindowsFloors(b.floors, b.floorsFrom) : null,
        b.wallHeightFt !== null ? `eaves ${Math.round(b.wallHeightFt)} ft up` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(', '),
      b.lowWingFt > 0 ? `${Math.round(b.lowWingFt)} ft of a low one-storey wing (likely a garage or porch) left out` : null,
      b.outlineFrom === 'google-roof' ? 'Outline traced from the roof seen from above, as no building footprint was found' : null,
      b.windows !== null
        ? `${b.covers === 'sides-and-back' ? 'Sides and back: about' : 'About'} ${b.range !== null ? `${b.range.low} to ${b.range.high} windows, most likely ${b.windows}` : plural(b.windows, 'window', 'windows')}`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join('. '),
  floorsWithSource: (floors: number, from: 'height-map' | 'photo' | 'assumed') => measureWindowsFloors(floors, from),
  // Word joiners round the dash: the range never breaks over two lines.
  range: (low: number, high: number) => `${low}\u2060\u2013\u2060${high}`,
  mostLikely: (n: number) => `Most likely ${n}`,
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
    'walls-unconfirmed':
      'We can\u2019t confirm the front wall drawn from the outline sits on the house in the photo, so sizes from it may be off. Under Adjust, drag its corners onto the house, or mark a door as a ruler.',
  },
  standIn: 'Demo detector: these windows are made up. Add a detector key for real windows.',
  estimatedFromSizeNoTools: 'Estimated from the house’s size. Add windows from photos for real sizes.',

  // Why no window could be seen on the photo
  missing: {
    'no-street-view': 'No street-level photo of this house. The quote uses the estimate from the walls.',
    'house-blurred': 'The owner had this house blurred in street-level imagery, so no window could be marked. The quote uses the estimate from the walls.',
    'facade-hidden': 'Trees, fences or cars hide the front of the house on the photo. The quote uses the estimate from the walls.',
    'no-footprint': 'No building outline was found for this address, so the walls could not be measured. Type in the window counts with Adjust counts.',
    'detector-unconfigured': 'No window finder is set up. Mark the front windows on the photo, or use the estimate.',
    'detector-error': 'The window finder did not answer. Mark the front windows on the photo, or use the estimate.',
  },
  noEstimate: 'No estimate for this house. Type in the window counts with Adjust counts.',

  // The quote
  quoteTitle: 'Window quote',
  quoteWaits: 'The quote appears when Estimator has measured the windows: Good, Better and Best, line by line.',
  quoteStillEstimates: (n: number) => `${n === 1 ? '1 window is' : `${n.toLocaleString()} windows are`} still an estimate, so this price can change once it is measured.`,
  quoteBar: { label: (tier: string, windows: number) => `${tier} \u00b7 ${windows === 1 ? '1 window' : `${windows.toLocaleString()} windows`}`, open: 'Quote' },
  quoteLine: (windows: number, measured: number) =>
    measured === 0 ? `${plural(windows, 'window', 'windows')}, all estimated` : `${plural(windows, 'window', 'windows')}, ${measured.toLocaleString()} measured`,
  quoteGroup: (tier: string) => `Windows for ${tier}`,
  quoteLineName: (cls: string) => `${cls} windows`,
  quoteLineQty: (count: number, unit: string) => `${count} × ${unit}`,
  noWindows: 'No windows to price yet.',
  quoteFailed: 'We could not price these windows.',
  quoteLoading: 'Pricing the windows',
  send: 'Send proposal',
  sendNext: 'Window proposals cannot be sent from here yet. Share this quote with the customer yourself.',
} as const;

/** Words for sizing windows from photos taken on site (features/measure/windows/photos). */
export const windowPhotos = {
  add: 'Add on-site photos',
  title: 'Photograph windows',
  close: 'Done',
  back: 'Back to the photos',
  guidance:
    'For exact sizes, use the measuring sheet. No sheet with you? Plain printer paper on the glass, or one side measured with a tape, still works.',
  take: 'Take photos',
  library: 'Choose from library',
  takeLabel: 'Take photos of windows',
  libraryLabel: 'Choose photos of windows',
  uploading: (name: string) => `Uploading ${name}`,
  uploaded: 'Ready to measure',
  uploadFailed: 'This photo did not upload. Try again.',
  tooBig: 'This photo is too big to upload, even made smaller. Take it again at a smaller size.',
  wrongType: 'Use a JPEG, PNG or HEIC photo.',
  heicUnsupported:
    'This photo is in the HEIC (high efficiency) format, which this browser cannot open. Set the camera to save JPEG and take it again: on iPhone, Settings > Camera > Formats > Most Compatible; on Samsung, Camera settings > Advanced > High efficiency pictures off.',
  preparing: 'Getting the photo ready…',
  waitingOffline: 'Waiting for a connection. It uploads by itself.',
  photosWaiting: (n: number) => (n === 1 ? '1 photo waiting to upload' : `${n} photos waiting to upload`),
  retry: 'Try again',
  remove: 'Remove',
  measure: 'Measure',
  measured: 'Measured',
  noUploads: 'No photos yet. Take one photo per window.',
  photoNumber: (n: number) => `Photo ${n}`,

  // The measure view
  measureTitle: 'Measure this window',
  photoLabel: 'The window photo: drag the corners onto the window',
  methodLabel: 'How to size it',
  methodReference: 'Paper on the glass',
  methodKnownSide: 'I measured one side',
  recommended: 'Recommended',
  referenceHint: 'Drag the blue corners onto the paper and the yellow corners onto the window frame.',
  knownSideHint: 'Drag the yellow corners onto the window frame, then type the width or the height you measured.',
  paperSize: 'Paper size',
  papers: { letter: 'Letter (8.5 × 11 in)', legal: 'Legal (8.5 × 14 in)', a4: 'A4 (8.3 × 11.7 in)' },
  side: 'Side measured',
  sides: { width: 'Width', height: 'Height' },
  inches: 'Inches',
  windowCorner: { 0: 'top left', 1: 'top right', 2: 'bottom right', 3: 'bottom left' },
  windowCornerLabel: (corner: string) => `Window corner, ${corner}. Drag it, or use the arrow keys.`,
  paperCornerLabel: (corner: string) => `Paper corner, ${corner}. Drag it, or use the arrow keys.`,
  size: (w: number, h: number) => `${w.toFixed(1)} × ${h.toFixed(1)} in`,
  sizeLabel: 'Size',
  noSize: 'Move the corners to size the window.',
  cornersFirst: (placed: number, of: number) => `Place every corner to see the size (${placed} of ${of}).`,
  typeSide: 'Type the side you measured.',
  check: 'Check the corners: the photo is at a steep angle or the corners are nearly in a line.',
  fromServer: 'Checked by Estimator',
  live: 'Live',
  label: 'Label (optional)',
  labelPlaceholder: 'Kitchen',
  save: 'Save window',
  cancel: 'Cancel',
  delete: 'Delete window',
  loupe: 'Magnified view of the corner',

  // In the card
  listTitle: 'Photographed windows',
  chip: 'Photo',
  untitled: (n: number) => `Window ${n}`,
  rowLabel: (name: string, size: string) => `${name}, ${size}. Open to edit.`,
  edit: 'Edit',
  inQuote: 'In the quote',
  deleteRow: (name: string) => `Delete ${name}`,
  coverAll: 'I photographed every window',
  coverAllHint: 'The estimate then counts nothing; the quote is the photographed windows (and any counts you typed).',
  fromPhotos: 'counted from photos',
  photosOfWindow: (n: number) => (n === 1 ? '1 photo' : `${n} photos`),
  groupSpread: (n: number, spread: string) => `${n} photos agree within ${spread} in`,
  anotherPhoto: (name: string) => `Add another photo of ${name}`,

  // The measuring sheet (recommended)
  methodSheet: 'Measuring sheet',
  sheetHintProposed: 'The window was found around the sheet. Check the yellow corners sit on the window frame.',
  sheetHintPlace: 'Drag the four corners onto the frame.',
  sheetHintCheck: 'Check the yellow corners sit on the window frame.',
  howToTitle: 'How to photograph a window',
  howTo: [
    'Tape the measuring sheet flat on the glass, in a lower corner.',
    'Stand straight in front, 4 to 8 ft back, with the whole window frame in the photo.',
    'Take 2 or 3 photos of each window.',
  ],
  bigWindow: 'For windows wider than about 4 ft, tape a second sheet in the opposite corner.',
  sheetLetters: ['Sheet A', 'Sheet B'],
  sheetPick: 'Which sheet',
  twoSheets: 'Two sheets found',
  twoSheetsSize: 'Sized from both sheets',
  noCameraData: 'No camera data in this photo, so the size is less certain.',
  printCheckTitle: 'Check the print',
  printCheckHint: (length: number, unit: string) => `Measure the ruler on the printed sheet. It should be exactly ${length} ${unit}.`,
  printCheckField: (unit: string) => `The ruler measured (${unit})`,
  printCheckScale: (pct: string) => `Printed at ${pct}%`,
  printCheckSaved: (pct: string) => `Saved: sizes from this sheet are corrected for ${pct}% on this device.`,
  printCheckSave: 'Save the print check',
  printCheckOff: 'That is more than 10% off. Print the sheet again with the scale set to "Actual size".',
  printCheckApplied: (pct: string) => `Corrected for the sheet printed at ${pct}%`,
  pickTitle: 'Which outline are you measuring?',
  pickHint: 'The frame has more than one edge here. Tap the outline that matches what you are measuring.',
  pickOption: (letter: string, size: string, layer: string) => `${letter}: ${size}, ${layer}`,
  pickLetters: ['A', 'B', 'C'],
  pickCorner: (letter: string) => `Close-up of outline ${letter} at its corner`,
  layers: { 'outer-trim': 'outside of the trim', 'frame-inner': 'inside of the frame', sash: 'the sash', glass: 'the glass', unknown: 'an edge' },
  pickMatches: 'Matches what you are measuring',
  printOpen: 'Print the measuring sheet',
  printTitle: 'The measuring sheet',
  printIntro: 'Print it once and use it on every job. Keep it flat: a bent or creased sheet measures wrong.',
  printPaper: 'Paper',
  printPapers: { letter: 'Letter (8.5 × 11 in)', a4: 'A4 (210 × 297 mm)' },
  print: 'Print',
  download: 'Download',
  downloadName: (paper: string) => `measuring-sheet-${paper}.svg`,
  printRulerCheck:
    'After printing, check the ruler on the sheet with a tape measure. If it is not exactly right, print again with the scale set to "Actual size" (or 100%), not "Fit to page".',
  printPreview: 'The measuring sheet, as it prints',
  printLoading: 'Getting the measuring sheet ready…',
  engineLoading: 'Getting the measuring tools ready…',
  engineUnavailable: 'The measuring sheet cannot be read on this device right now. Use "Paper on the glass" or "I measured one side".',
  reading: 'Looking for the measuring sheet…',
  sheetFound: 'Measuring sheet found',
  sheetOutline: 'The measuring sheet found in the photo',
  sheetMissing: 'The measuring sheet is not in this photo, or it is too small or blurred to read.',
  sheetFixes: ['Get closer, so the sheet is bigger in the photo.', 'Turn on more light, or open the blinds.', 'Get the whole sheet in the photo, with nothing over it.', 'Hold the phone still as you take it.'],
  retakePhoto: 'Take this photo again',
  quality: (feet: number, degrees: number) => `${feet.toFixed(1)} ft away, ${Math.round(degrees)}° off straight-on`,
  snap: 'Snap corners to the frame',
  noSnap: "Don't snap",
  snapping: 'Fitting the corners to the frame…',
  placeCorners: (n: number) => `Drag each yellow corner onto the frame (${n} of 4). They fit to its edges once all four are placed.`,
  snapped: 'Corners fitted to the frame edges',
  checkEdge: 'Check this edge',
  sideNames: ['top', 'right', 'bottom', 'left'],
  checkEdges: (sides: string) => `Check the ${sides} edge: the frame line there is faint. Drag its corners onto it.`,
  edgeLabel: (side: string, sure: number) => `The ${side} edge, ${Math.round(sure * 100)}% sure`,
  targetLabel: 'What are you measuring?',
  targets: {
    frame: { label: 'Inside of the frame', hint: 'The usual replacement size' },
    trim: { label: 'Outside of the trim', hint: '' },
    glass: { label: 'The glass itself', hint: '' },
    custom: { label: 'Something else', hint: '' },
  },
  practice: 'Replacement practice: measure the width at the top, middle and bottom and use the smallest; the same for the height.',
  advanced: 'Advanced: distance in front of the glass',
  offsetField: 'Inches in front of the glass (behind is negative)',
  sizeExact: (w: string, h: string) => `${w} × ${h} in`,
  plusMinus: (u: string) => `± ${u} in`,
  combinedLabel: (n: number) => `Combined from ${n} photos`,
  spread: (u: string) => `Photos differ by up to ${u} in`,
  retake: 'Take another photo of this window: this one is not exact enough to order from.',
  retakeWhy: (u: string) => `The size could be off by ${u} in.`,
  whichWindow: 'This photo is of',
  newWindow: 'A new window',

  // AR on an Android phone (WebXR): tap the frame's corners through the camera
  methodAr: 'AR (Android)',
  arHint: 'Point the phone at the window and tap its four frame corners. No sheet needed.',
  arNoSize: 'Tap the four frame corners in AR to size the window.',
  arGuidance: [
    "Tap the window FRAME corners, not the glass (glass doesn't give AR hits)",
    'Move the phone slowly side to side first so AR finds the wall',
    'Good light helps',
    'Measure each window twice',
  ],
  arOnlyAndroid: 'AR measuring needs an Android phone with Chrome. The measuring sheet works on every phone.',
  arStartFromCapture: 'Measure with AR',
  arStart: 'Start AR',
  arAgain: 'Measure again in AR',
  arStarting: 'Starting AR…',
  arFailed: 'AR could not start on this phone. Use the measuring sheet instead.',
  arOverlay: 'AR measuring',
  arSearching: 'Move the phone slowly side to side so AR finds the wall',
  arLost: 'Move slowly to find the wall again',
  arAimAt: (corner: string) => `Aim the dot at the ${corner} corner of the frame, then tap`,
  arAllPlaced: 'All four corners placed. Check the sides, then Finish.',
  arFrameTip: 'Frame corners, not the glass',
  arCornerNames: ['top left', 'top right', 'bottom right', 'bottom left'],
  arEdgeNames: ['Top', 'Right', 'Bottom', 'Left'],
  arEdge: (name: string, inches: string) => `${name} ${inches} in`,
  arCornersPlaced: (n: number) => `${n} of 4 corners`,
  arLostTimes: (n: number) => (n === 1 ? 'AR lost the wall once' : `AR lost the wall ${n} times`),
  arPlace: 'Place corner',
  arUndo: 'Undo',
  arRestart: 'Start over',
  arFinish: 'Finish',
  arExit: 'Exit AR',
  arSaving: 'Keeping a picture of the window…',
  arUploading: 'Uploading the picture…',
  arUploadFailed: 'The picture did not upload. Try again.',
  arNeedPhoto: 'AR could not keep a picture on this phone. Take one normal photo of the same window, from where you stood.',
  arTakePhoto: 'Take the photo',
  arTakePhotoLabel: 'Take a photo of the window you measured in AR',
  arCornersApprox: 'The corners on the photo are only a guide: the size comes from AR.',
  arMeasuredWith: 'Measured in AR',
  arCheck: 'Check this window: the corners do not make a clean rectangle. Measure it again in AR.',
  arCheckWhy: (why: string) => `Why: ${why}.`,
} as const;
