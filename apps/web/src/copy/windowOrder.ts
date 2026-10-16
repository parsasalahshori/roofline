/** Words for the window factory order (features/measure/windows/order): photo windows turned into a sheet the factory builds from. */
import {
  fractionInches,
  windowStyleName,
  WINDOW_STYLES,
  type FrameColor,
  type GlassPackage,
  type GridType,
  type OrderLineStatus,
  type ScreenType,
  type WindowOrderStatus,
  type WindowStyle,
} from '@roofline/shared';

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const inches = (n: number) => fractionInches(n);

export const windowOrder = {
  title: 'Factory order',
  subtitle: 'The sheet the window factory builds from',
  back: 'Back to windows',
  onlyPhotoNote:
    'Only windows measured from on-site photos can be ordered. Street View and estimated windows are not precise enough to build from.',

  // Loading and creating
  loading: 'Loading the order…',
  preparing: 'Preparing the order',
  preparingBody: 'Turning the windows measured from on-site photos into order lines.',
  noPhotoWindowsTitle: 'No windows measured from on-site photos yet',
  noPhotoWindowsBody: 'Take photos of each window on site and measure them, then come back to order.',
  loadFailed: 'We could not open the order.',
  tryAgain: 'Try again',
  refresh: 'Bring in new photo windows',
  refreshing: 'Bringing in photo windows…',

  // The ticket at the top: what the order is, where, its PO and how many lines
  ticketLabel: 'Order details',
  ticket: { address: 'Address', lines: 'Lines', noPo: 'None' },
  /** The rule the order size follows, from the company's own settings (the fit allowance and the rounding step). */
  rule: (fit: string, step: string) => `Order size = the smallest photo reading, less its error and ${fit} in for fit, rounded down to ${step} in.`,
  ruleSplit: (width: string, height: string, step: string) =>
    `Order size = the smallest photo reading, less its error and ${width} in wide and ${height} in high for fit, rounded down to ${step} in.`,
  statusLabel: 'Order status',
  status: { draft: 'Draft', ready: 'Ready', sent: 'Sent' } satisfies Record<WindowOrderStatus, string>,
  poLabel: 'PO number',
  poPlaceholder: 'Optional',
  poShown: (po: string) => `PO ${po}`,

  // Saving
  saving: 'Saving…',
  saved: 'All changes saved',
  saveFailed: (why: string) => `Could not save: ${why}`,

  // The lines table
  linesTitle: 'Windows to order',
  tableCaption: 'Windows to order. Sizes come from the on-site photos and cannot be typed.',
  columns: {
    select: 'Select',
    line: 'Ln',
    photo: 'Photo',
    location: 'Location',
    measured: 'Measured',
    order: 'Order size',
    spec: 'Spec',
    quantity: 'Qty',
    status: 'Status',
  },
  /** The spec column's head says so once when every window has the same frame colours. */
  allColors: (ext: string, int: string) => `all ${ext} / ${int}`,
  colorsSlash: (ext: string, int: string) => `${ext} / ${int}`,
  glassShort: { 'lowe-argon': 'Low-E argon', 'triple-lowe-argon': 'Triple Low-E argon' } satisfies Record<GlassPackage, string>,
  lineName: (n: number) => String(n).padStart(2, '0'),
  openLine: (n: number, location: string) => `Open window ${n}, ${location}`,
  windowNumber: (n: number) => `Window ${n}`,
  selectLine: (n: number, location: string) => `Select window ${n}, ${location}`,
  selectAll: 'Select all windows',
  photoAlt: (location: string) => `On-site photo of the window: ${location}`,
  locationFor: (n: number) => `Location of window ${n}`,
  quantityFor: (n: number) => `Quantity of window ${n}`,
  optionsFor: (n: number, location: string) => `Options for window ${n}, ${location}`,
  size: (w: number, h: number) => `${inches(w)} × ${inches(h)} in`,
  plusMinus: (u: number) => `± ${inches(u)}`,
  photosCount: (n: number) => plural(n, 'photo', 'photos'),
  noSize: 'No size',
  orderHint: 'Smallest measured, less the fit allowance, rounded down',
  specialOrder: 'Special order',

  // Pickers
  style: 'Style',
  pickStyle: 'Pick a style',
  styles: Object.fromEntries(WINDOW_STYLES.map((s) => [s, windowStyleName(s)])) as Record<WindowStyle, string>,
  exterior: 'Exterior color',
  interior: 'Interior color',
  colors: {
    white: 'White',
    almond: 'Almond',
    clay: 'Clay',
    bronze: 'Bronze',
    black: 'Black',
    woodgrain: 'Woodgrain',
  } satisfies Record<FrameColor, string>,
  grid: 'Grids',
  grids: { none: 'No grid', colonial: 'Colonial', prairie: 'Prairie', custom: 'Custom' } satisfies Record<GridType, string>,
  gridTop: 'Top sash grid',
  gridBottom: 'Bottom sash grid',
  gridLeft: 'Left sash grid',
  gridRight: 'Right sash grid',
  gridOnly: 'Grid pattern',
  gridPlaceholder: 'Like 3x2',
  glass: 'Glass',
  glasses: { 'lowe-argon': 'Low-E + argon (dual pane)', 'triple-lowe-argon': 'Triple pane, Low-E + argon' } satisfies Record<GlassPackage, string>,
  tempered: 'Tempered',
  obscure: 'Obscure',
  screen: 'Screen',
  screens: { none: 'No screen', half: 'Half screen', full: 'Full screen' } satisfies Record<ScreenType, string>,
  notes: 'Notes for the factory',

  // Safety glass
  safetyTitle: 'Safety glass',
  besideDoor: 'Within 24 in of a door?',
  wetArea: 'Beside a tub or shower?',
  walkway: 'Floor you can walk on within 36 in?',
  yes: 'Yes',
  no: 'No',
  sill: 'Sill height (in)',
  sillHelp: 'Bottom of the glass above the floor',
  useTempered: 'Use tempered',
  temperedChosen: 'Tempered glass chosen.',

  // Line status
  lineStatus: { ready: 'Ready', check: 'Check', error: 'Hold' } satisfies Record<OrderLineStatus, string>,
  lineStatusLabel: (status: string) => `Status: ${status}`,
  reasonsLabel: 'What to fix',
  confirm: 'I checked this window',

  // The picked line
  detailTitle: (n: number, location: string) => `Line ${String(n).padStart(2, '0')} · ${location}`,
  detailLabel: 'Window details',
  noPhoto: 'No photo for this window.',
  nothingPicked: 'Pick a window to see its photo and readings and to change how it is built.',
  readings: {
    title: 'Photo readings',
    head: { photo: 'Photo', size: 'Size' },
    photo: (n: number) => `Photo ${n}`,
    roomScan: 'Room scan, quote only',
    /** What the order takes from a reading: its side or sides that are the smallest over the photos. */
    smallest: { width: 'Smallest width', height: 'Smallest height', both: 'Smallest width and height' },
    note: 'The order uses the smallest reading of each side, highlighted.',
  },
  optionsTitle: 'How it is built',

  // Bulk apply
  bulkLabel: 'Change selected windows',
  bulkSelected: (n: number) => `${plural(n, 'window', 'windows')} selected`,
  leaveAsIs: 'Leave as is',
  bulkApply: (n: number) => `Apply to ${plural(n, 'window', 'windows')}`,
  bulkClear: 'Clear selection',
  bulkTemperedYes: 'Tempered',
  bulkTemperedNo: 'Not tempered',

  // Totals and the sheet preview
  totalsTitle: 'Totals',
  totals: {
    windows: 'Windows',
    unitedIn: 'United inches',
    sqFt: 'Sq ft',
    lines: 'Sheet lines',
    specialOrders: 'Special orders',
  },
  sheetTitle: 'Sheet preview',
  sheetCaption: 'Windows built the same way share one line on the sheet.',
  sheetEmpty: 'Lines show here once each window has a style.',
  sheetColumns: { line: 'Line', qty: 'Qty', locations: 'Locations', style: 'Style', size: 'Order size', options: 'Options' },
  sheetGrid: (type: string, patterns: string) => (patterns === '' ? type : `${type} ${patterns}`),
  colorsPair: (ext: string, int: string) => (ext === int ? ext : `${ext} outside, ${int} inside`),

  // Actions and the foot of the table
  actionsTitle: 'Order',
  counts: { ready: (n: number) => `${n} ready`, check: (n: number) => `${n} to check`, hold: (n: number) => `${n} on hold` },
  saveDraft: 'Save draft',
  markReady: 'Mark ready (locks sizes)',
  markingReady: 'Marking ready…',
  reopen: 'Reopen',
  reopening: 'Reopening…',
  ownerMarksReady: 'Owner or office marks the order ready.',
  linesNeedAttention: (n: number) => `${plural(n, 'window needs', 'windows need')} attention before the order can be marked ready.`,
  noLines: 'There are no windows on this order.',
  readyLocked: 'Sizes and options are locked. Reopen to change them.',
  sentLocked: 'This order was sent to the factory.',
  downloadCsv: 'Download CSV',
  downloadPdf: 'Download PDF / print sheet',
  draftPdf: 'Draft preview (PDF)',
  sendNote: 'Download the sheet and send it to the factory.',
  actionFailed: 'That did not work. Try again.',

  // The chip on the windows screen
  chip: (status: string) => `Factory order: ${status}`,
  createOrder: 'Create factory order',
};
