// Window factory order: windows measured on site (photo windows) turned into an order sheet a window factory builds from.
//
// Only photo windows (measured from on-site photos) may be ordered. Street View marked windows, detector windows and
// estimated counts are never precise enough to build a window from, so they never become order lines.
//
// Everything here is pure: the API stores the lines and a snapshot of the company's settings, and both the API and the
// web app run the same checks (order size, factory limits, safety glass, status) from this file.

/* ------------------------------------------------------------------------------------------------------------------ */
/* Options a line can carry                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Window styles. 'arch' and 'circle' are specialty shapes: always a special order at the factory. */
export const WINDOW_STYLES = ['double-hung', 'single-hung', 'slider-2', 'slider-3', 'picture', 'casement', 'awning', 'arch', 'circle'] as const;
export type WindowStyle = (typeof WINDOW_STYLES)[number];
export const SPECIALTY_STYLES: ReadonlySet<WindowStyle> = new Set(['arch', 'circle']);

/** Frame colours (interior and exterior chosen separately). */
export const FRAME_COLORS = ['white', 'almond', 'clay', 'bronze', 'black', 'woodgrain'] as const;
export type FrameColor = (typeof FRAME_COLORS)[number];

export const GRID_TYPES = ['none', 'colonial', 'prairie', 'custom'] as const;
export type GridType = (typeof GRID_TYPES)[number];
/** A sash's grid pattern: lites wide x lites high ("3x2"); '' = no grid on that sash. */
export const GRID_PATTERN = /^(?:[1-9]x[1-9])?$/;
/**
 * The grid: its type, and a pattern per sash. `top` is the upper sash of a hung window, the left sash of a slider, and
 * the only sash of a one-sash style (picture, casement, awning, arch, circle); `bottom` is ignored there.
 */
export type WindowGrid = { type: GridType; top: string; bottom: string };

/** Glass packages: dual-pane Low-E with argon is the default; triple-pane Low-E with argon is the upgrade. */
export const GLASS_PACKAGES = ['lowe-argon', 'triple-lowe-argon'] as const;
export type GlassPackage = (typeof GLASS_PACKAGES)[number];

export const SCREEN_TYPES = ['none', 'half', 'full'] as const;
export type ScreenType = (typeof SCREEN_TYPES)[number];

/** The yes/no questions a person answers per window so we can suggest safety glass. null = not answered yet. */
export type SafetyAnswers = {
  /** Is the glass within 24 in of the edge of a door (door closed)? */
  besideDoor: boolean | null;
  /** Is it in a wall around a bathtub, shower, hot tub or pool? */
  wetArea: boolean | null;
  /** The bottom of the glass above the floor (or tub / shower floor, for a wet area), inches. */
  sillHeightIn: number | null;
  /** Is there a floor you can walk on within 36 in of the glass (inside or out)? */
  walkway: boolean | null;
};
export const NO_SAFETY_ANSWERS: SafetyAnswers = { besideDoor: null, wetArea: null, sillHeightIn: null, walkway: null };

/** The size of one window as measured on site from its photo(s). */
export type MeasuredSize = {
  widthIn: number;
  heightIn: number;
  /** Expected error (inches, about 1 sigma) when the measuring method can tell; null when it cannot. */
  uncertaintyIn: { width: number; height: number } | null;
  quality: 'good' | 'check';
  /**
   * True for a quote-grade measurement (the iPhone's RoomPlan room scan): shown, but never used for the order size; a
   * line measured only this way cannot be ordered. Absent: order-grade.
   */
  quoteOnly?: boolean;
};

/** One order line: one window (all its photos), with what the factory needs to build it. */
export type WindowOrderLine = {
  /** The photo window's key (several photos of one window share it). */
  id: string;
  /** The photo windows this line was measured from (one per photo). */
  photoWindowIds: string[];
  /** The photo to show as the thumbnail; null when none of the window's measurements has a photo (a room scan). */
  uploadId: string | null;
  location: string;
  style: WindowStyle | null;
  /** Each photo's measurement; the order size uses the smallest (an opening is ordered from its tightest point). */
  measured: MeasuredSize[];
  quantity: number;
  frameInterior: FrameColor;
  frameExterior: FrameColor;
  grid: WindowGrid;
  glass: GlassPackage;
  tempered: boolean;
  obscure: boolean;
  screen: ScreenType;
  notes: string;
  safety: SafetyAnswers;
  /** The person looked at a 'check' line (photo quality, uncertainty or a safety-glass suggestion) and it is right. */
  confirmed: boolean;
  /** Set when the order is marked ready: the order size the factory builds, locked. Null while a draft. */
  lockedSize: { widthIn: number; heightIn: number } | null;
};

/** Fields a person may change on a line (PATCH /api/window-orders/:id). Sizes come from the photos, never typed. */
export const EDITABLE_LINE_FIELDS = [
  'location',
  'style',
  'quantity',
  'frameInterior',
  'frameExterior',
  'grid',
  'glass',
  'tempered',
  'obscure',
  'screen',
  'notes',
  'safety',
  'confirmed',
] as const;
export type WindowOrderLinePatch = { id: string } & Partial<Pick<WindowOrderLine, (typeof EDITABLE_LINE_FIELDS)[number]>>;

export const MAX_ORDER_QUANTITY = 50;
export const MAX_LOCATION_LENGTH = 80;
export const MAX_NOTES_LENGTH = 300;

/** A new line's options: white inside and out, no grids, Low-E + argon, full screen. */
export function defaultLineOptions(): Omit<WindowOrderLine, 'id' | 'photoWindowIds' | 'uploadId' | 'location' | 'measured'> {
  return {
    style: null,
    quantity: 1,
    frameInterior: 'white',
    frameExterior: 'white',
    grid: { type: 'none', top: '', bottom: '' },
    glass: 'lowe-argon',
    tempered: false,
    obscure: false,
    screen: 'full',
    notes: '',
    safety: { ...NO_SAFETY_ANSWERS },
    confirmed: false,
    lockedSize: null,
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Company settings: the order-size rule and the factory's limits                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A factory's limits for one style, inches and square feet. */
export type StyleLimits = {
  minWidthIn: number;
  maxWidthIn: number;
  minHeightIn: number;
  maxHeightIn: number;
  /** Width + height. */
  maxUnitedIn: number;
  /** Largest unit with dual- or triple-pane argon glass. */
  maxAreaSqFt: number;
  /** Largest unit with tempered glass. */
  maxTemperedAreaSqFt: number;
};

/**
 * Default factory limits per style. These are typical vinyl replacement-window ranges, NOT WinChoice's published
 * limits (we do not have them yet): each company replaces them in its settings once the factory confirms its numbers.
 *
 * | style        | width   | height  | max UI | max sq ft | max tempered sq ft |
 * |--------------|---------|---------|--------|-----------|--------------------|
 * | double-hung  | 14-48   | 20-84   | 120    | 25        | 20                 |
 * | single-hung  | 14-48   | 20-84   | 120    | 25        | 20                 |
 * | slider-2     | 18-84   | 12-60   | 132    | 30        | 24                 |
 * | slider-3     | 48-120  | 12-60   | 160    | 40        | 32                 |
 * | picture      | 12-96   | 12-96   | 168    | 40        | 32                 |
 * | casement     | 14-36   | 20-72   | 100    | 15        | 15                 |
 * | awning       | 18-48   | 12-36   | 80     | 12        | 12                 |
 * | arch         | 12-96   | 6-48    | 130    | 25        | 20                 |
 * | circle       | 12-60   | 12-60   | 120    | 25        | 20                 |
 */
export const DEFAULT_STYLE_LIMITS: Readonly<Record<WindowStyle, StyleLimits>> = {
  'double-hung': { minWidthIn: 14, maxWidthIn: 48, minHeightIn: 20, maxHeightIn: 84, maxUnitedIn: 120, maxAreaSqFt: 25, maxTemperedAreaSqFt: 20 },
  'single-hung': { minWidthIn: 14, maxWidthIn: 48, minHeightIn: 20, maxHeightIn: 84, maxUnitedIn: 120, maxAreaSqFt: 25, maxTemperedAreaSqFt: 20 },
  'slider-2': { minWidthIn: 18, maxWidthIn: 84, minHeightIn: 12, maxHeightIn: 60, maxUnitedIn: 132, maxAreaSqFt: 30, maxTemperedAreaSqFt: 24 },
  'slider-3': { minWidthIn: 48, maxWidthIn: 120, minHeightIn: 12, maxHeightIn: 60, maxUnitedIn: 160, maxAreaSqFt: 40, maxTemperedAreaSqFt: 32 },
  picture: { minWidthIn: 12, maxWidthIn: 96, minHeightIn: 12, maxHeightIn: 96, maxUnitedIn: 168, maxAreaSqFt: 40, maxTemperedAreaSqFt: 32 },
  casement: { minWidthIn: 14, maxWidthIn: 36, minHeightIn: 20, maxHeightIn: 72, maxUnitedIn: 100, maxAreaSqFt: 15, maxTemperedAreaSqFt: 15 },
  awning: { minWidthIn: 18, maxWidthIn: 48, minHeightIn: 12, maxHeightIn: 36, maxUnitedIn: 80, maxAreaSqFt: 12, maxTemperedAreaSqFt: 12 },
  arch: { minWidthIn: 12, maxWidthIn: 96, minHeightIn: 6, maxHeightIn: 48, maxUnitedIn: 130, maxAreaSqFt: 25, maxTemperedAreaSqFt: 20 },
  circle: { minWidthIn: 12, maxWidthIn: 60, minHeightIn: 12, maxHeightIn: 60, maxUnitedIn: 120, maxAreaSqFt: 25, maxTemperedAreaSqFt: 20 },
};

/** Rounding steps the order size may be floored to. */
export const ORDER_ROUNDING_STEPS = [0.0625, 0.125, 0.25] as const;
export type OrderRounding = (typeof ORDER_ROUNDING_STEPS)[number];

/**
 * How a company turns a measured opening into the size it orders. Defaults below; each company may change them.
 *
 * The order-size rule (replacement / insert windows, ordered smaller than the opening so they fit):
 *   width  = floor_to_step( min over photos (measured width  - k x width uncertainty)  - widthDeductionIn )
 *   height = floor_to_step( min over photos (measured height - k x height uncertainty) - heightDeductionIn )
 * - "min over photos": an opening is ordered from its smallest measurement (several photos of one window each give one).
 * - k x uncertainty: when the photo method can tell its expected error, we take it off so we err small, never large.
 * - Rounding is always DOWN (a window 1/8 in small fits with a bit more sealant; 1/8 in large does not fit at all).
 * - A circle is ordered square: both sides are the smaller of the two.
 */
export type WindowOrderSettings = {
  /** Taken off the smallest measured width, inches. Default 1/4. */
  widthDeductionIn: number;
  /** Taken off the smallest measured height, inches. Default 1/4. */
  heightDeductionIn: number;
  /** The order size is floored to this step, inches. Default 1/8. */
  roundingIn: OrderRounding;
  /** k: how many uncertainties come off a measured size. Default 1. */
  uncertaintyFactor: number;
  /** A measurement whose uncertainty is over this (inches) is a 'check' line. Default 1/4. */
  checkUncertaintyIn: number;
  limits: Record<WindowStyle, StyleLimits>;
};

export const DEFAULT_WINDOW_ORDER_SETTINGS: WindowOrderSettings = {
  widthDeductionIn: 0.25,
  heightDeductionIn: 0.25,
  roundingIn: 0.125,
  uncertaintyFactor: 1,
  checkUncertaintyIn: 0.25,
  limits: { ...DEFAULT_STYLE_LIMITS },
};

/** What a company stores: any subset, limits per style partly or fully. */
export type WindowOrderSettingsPatch = Partial<Omit<WindowOrderSettings, 'limits'>> & { limits?: Partial<Record<WindowStyle, Partial<StyleLimits>>> };

/** A company's stored changes laid over the defaults. */
export function resolveOrderSettings(stored: WindowOrderSettingsPatch | null | undefined): WindowOrderSettings {
  const s = stored ?? {};
  const limits = Object.fromEntries(WINDOW_STYLES.map((style) => [style, { ...DEFAULT_STYLE_LIMITS[style], ...(s.limits?.[style] ?? {}) }])) as Record<WindowStyle, StyleLimits>;
  return {
    widthDeductionIn: s.widthDeductionIn ?? DEFAULT_WINDOW_ORDER_SETTINGS.widthDeductionIn,
    heightDeductionIn: s.heightDeductionIn ?? DEFAULT_WINDOW_ORDER_SETTINGS.heightDeductionIn,
    roundingIn: s.roundingIn ?? DEFAULT_WINDOW_ORDER_SETTINGS.roundingIn,
    uncertaintyFactor: s.uncertaintyFactor ?? DEFAULT_WINDOW_ORDER_SETTINGS.uncertaintyFactor,
    checkUncertaintyIn: s.checkUncertaintyIn ?? DEFAULT_WINDOW_ORDER_SETTINGS.checkUncertaintyIn,
    limits,
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The order size                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Floors to a step (1/8 in by default). A tiny epsilon keeps 35.875 from becoming 35.75 through float error. */
export function floorTo(value: number, step: number): number {
  return Math.floor(value / step + 1e-9) * step;
}

/**
 * The measurements an order may be sized from: the order-grade ones. Quote-grade ones (a room scan) are left out when
 * the window has any other measurement; when it has only quote-grade ones they are all there is (and checkLine makes
 * such a line an error, so it is never ordered).
 */
export function orderGradeMeasured(measured: readonly MeasuredSize[]): readonly MeasuredSize[] {
  const grade = measured.filter((m) => m.quoteOnly !== true);
  return grade.length > 0 ? grade : measured;
}

/** The size to order for a line's measurements (see WindowOrderSettings for the rule). Null when nothing is measured. */
export function orderSize(all: readonly MeasuredSize[], style: WindowStyle | null, settings: WindowOrderSettings): { widthIn: number; heightIn: number } | null {
  const measured = orderGradeMeasured(all);
  if (measured.length === 0) return null;
  const k = settings.uncertaintyFactor;
  const w = Math.min(...measured.map((m) => m.widthIn - k * (m.uncertaintyIn?.width ?? 0)));
  const h = Math.min(...measured.map((m) => m.heightIn - k * (m.uncertaintyIn?.height ?? 0)));
  let widthIn = floorTo(w - settings.widthDeductionIn, settings.roundingIn);
  let heightIn = floorTo(h - settings.heightDeductionIn, settings.roundingIn);
  if (style === 'circle') widthIn = heightIn = Math.min(widthIn, heightIn);
  return { widthIn, heightIn };
}

/** The smallest measured width and height and the largest uncertainty, for showing "36 1/4 x 60 (± 1/8)". */
export function smallestMeasured(all: readonly MeasuredSize[]): { widthIn: number; heightIn: number; uncertaintyIn: number | null } | null {
  const measured = orderGradeMeasured(all);
  if (measured.length === 0) return null;
  const us = measured.flatMap((m) => (m.uncertaintyIn === null ? [] : [m.uncertaintyIn.width, m.uncertaintyIn.height]));
  return {
    widthIn: Math.min(...measured.map((m) => m.widthIn)),
    heightIn: Math.min(...measured.map((m) => m.heightIn)),
    uncertaintyIn: us.length === 0 ? null : Math.max(...us),
  };
}

/** Inches as a whole number and a fraction in eighths (or sixteenths): 35.875 -> "35 7/8". */
export function fractionInches(value: number): string {
  const sixteenths = Math.round(value * 16);
  const whole = Math.floor(sixteenths / 16);
  let num = sixteenths - whole * 16;
  if (num === 0) return `${whole}`;
  let den = 16;
  while (num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  return whole === 0 ? `${num}/${den}` : `${whole} ${num}/${den}`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Safety glass (tempered) suggestions                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

export type SafetyRule = 'door' | 'wet-area' | 'large-low-pane';
export type SafetySuggestion = { rule: SafetyRule; code: string; message: string };

/** The share of the unit one pane takes, roughly: a hung window or 2-lite slider has two, a 3-lite slider three. */
const PANES: Readonly<Record<WindowStyle, number>> = { 'double-hung': 2, 'single-hung': 2, 'slider-2': 2, 'slider-3': 3, picture: 1, casement: 1, awning: 1, arch: 1, circle: 1 };

/**
 * Where tempered (safety) glass is suggested. Hazardous locations follow the 2021 International Residential Code,
 * section R308.4 (most US states adopt it; check the local edition):
 * - R308.4.2 Glazing adjacent to doors: within a 24 in arc of either vertical edge of a door in the closed position,
 *   with its bottom edge less than 60 in above the floor.
 * - R308.4.3 Glazing in windows: an individual pane larger than 9 sq ft, AND its bottom edge less than 18 in above the
 *   floor, AND its top edge more than 36 in above the floor, AND a walking surface within 36 in horizontally of the glass.
 * - R308.4.5 Glazing and wet surfaces: in walls enclosing or facing a bathtub, shower, hot tub, spa, whirlpool, sauna,
 *   steam room or indoor/outdoor pool, where the bottom edge is less than 60 in above any standing or walking surface.
 * (R308.4.6/4.7, stairways and landings, are not asked about here: the person adds tempered by hand.)
 *
 * These are suggestions shown to the person, never forced on a line: they answer the questions and decide.
 * An unanswered sill height does not hide a door or wet-area suggestion (we err towards suggesting).
 */
export function temperedSuggestions(line: Pick<WindowOrderLine, 'safety' | 'style'>, size: { widthIn: number; heightIn: number } | null): SafetySuggestion[] {
  const out: SafetySuggestion[] = [];
  const { besideDoor, wetArea, sillHeightIn, walkway } = line.safety;
  const lowerThan60 = sillHeightIn === null || sillHeightIn < 60;
  if (besideDoor === true && lowerThan60) {
    out.push({ rule: 'door', code: 'IRC R308.4.2', message: 'Tempered glass suggested: within 24 in of a door, under 60 in from the floor (IRC R308.4.2).' });
  }
  if (wetArea === true && lowerThan60) {
    out.push({ rule: 'wet-area', code: 'IRC R308.4.5', message: 'Tempered glass suggested: beside a tub or shower, under 60 in above where you stand (IRC R308.4.5).' });
  }
  if (size !== null && sillHeightIn !== null && walkway === true) {
    const paneSqFt = (size.widthIn * size.heightIn) / 144 / PANES[line.style ?? 'picture'];
    const topIn = sillHeightIn + size.heightIn;
    if (paneSqFt > 9 && sillHeightIn < 18 && topIn > 36) {
      out.push({ rule: 'large-low-pane', code: 'IRC R308.4.3', message: 'Tempered glass suggested: a pane over 9 sq ft, low to the floor, beside a walkway (IRC R308.4.3).' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Checking a line                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

export const ORDER_LINE_STATUSES = ['ready', 'check', 'error'] as const;
export type OrderLineStatus = (typeof ORDER_LINE_STATUSES)[number];

export type OrderLineReason = { level: 'check' | 'error'; message: string };

export type CheckedLine = {
  id: string;
  status: OrderLineStatus;
  /** Plain reasons, errors first. Empty when ready. */
  reasons: OrderLineReason[];
  /** The size to order (the locked one once the order is ready). */
  order: { widthIn: number; heightIn: number } | null;
  suggestions: SafetySuggestion[];
  specialOrder: boolean;
  /** True when the line is fine to order: ready, or 'check' that the person confirmed. */
  orderable: boolean;
};

const STYLE_NAMES: Readonly<Record<WindowStyle, string>> = {
  'double-hung': 'Double-hung',
  'single-hung': 'Single-hung',
  'slider-2': 'Slider, 2-lite',
  'slider-3': 'Slider, 3-lite',
  picture: 'Picture',
  casement: 'Casement',
  awning: 'Awning',
  arch: 'Arch',
  circle: 'Circle',
};
export const windowStyleName = (s: WindowStyle): string => STYLE_NAMES[s];

const ONE_SASH: ReadonlySet<WindowStyle> = new Set(['picture', 'casement', 'awning', 'arch', 'circle']);

/** A line's status: 'error' (cannot be ordered), 'check' (look at it first) or 'ready', with plain reasons. */
export function checkLine(line: WindowOrderLine, settings: WindowOrderSettings): CheckedLine {
  const errors: string[] = [];
  const checks: string[] = [];
  const order = line.lockedSize ?? orderSize(line.measured, line.style, settings);

  if (line.location.trim() === '') errors.push('Name the room or location.');
  if (line.style === null) errors.push('Pick a style.');
  if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_ORDER_QUANTITY) errors.push(`Quantity must be 1 to ${MAX_ORDER_QUANTITY}.`);
  if (line.measured.length === 0 || order === null) errors.push('No on-site measurement for this window.');
  else if (line.measured.every((m) => m.quoteOnly === true)) {
    errors.push('Measured by room scan only (good for a quote, not an order): measure this window in AR or with the measuring sheet.');
  }
  if (line.grid.type !== 'none') {
    const patterns = line.style !== null && ONE_SASH.has(line.style) ? [line.grid.top] : [line.grid.top, line.grid.bottom];
    if (!patterns.every((p) => GRID_PATTERN.test(p))) errors.push('Grid patterns look like 3x2 (lites wide x high).');
    if (patterns.every((p) => p === '')) errors.push('Give a grid pattern for at least one sash, or pick no grid.');
  }

  if (order !== null && line.style !== null) {
    const lim = settings.limits[line.style];
    const f = fractionInches;
    if (order.widthIn <= 0 || order.heightIn <= 0) errors.push('The measured size is too small to order.');
    else {
      if (order.widthIn < lim.minWidthIn) errors.push(`Width ${f(order.widthIn)} in is under the ${f(lim.minWidthIn)} in smallest for ${windowStyleName(line.style)}.`);
      if (order.widthIn > lim.maxWidthIn) errors.push(`Width ${f(order.widthIn)} in is over the ${f(lim.maxWidthIn)} in largest for ${windowStyleName(line.style)}.`);
      if (order.heightIn < lim.minHeightIn) errors.push(`Height ${f(order.heightIn)} in is under the ${f(lim.minHeightIn)} in smallest for ${windowStyleName(line.style)}.`);
      if (order.heightIn > lim.maxHeightIn) errors.push(`Height ${f(order.heightIn)} in is over the ${f(lim.maxHeightIn)} in largest for ${windowStyleName(line.style)}.`);
      const ui = order.widthIn + order.heightIn;
      if (ui > lim.maxUnitedIn) errors.push(`${f(ui)} united inches is over the ${f(lim.maxUnitedIn)} largest for ${windowStyleName(line.style)}.`);
      const sqft = (order.widthIn * order.heightIn) / 144;
      if (sqft > lim.maxAreaSqFt) errors.push(`${sqft.toFixed(1)} sq ft is over the ${lim.maxAreaSqFt} sq ft largest for this glass in ${windowStyleName(line.style)}.`);
      if (line.tempered && sqft > lim.maxTemperedAreaSqFt) errors.push(`${sqft.toFixed(1)} sq ft is over the ${lim.maxTemperedAreaSqFt} sq ft largest for tempered glass in ${windowStyleName(line.style)}.`);
    }
  }

  if (orderGradeMeasured(line.measured).some((m) => m.quality === 'check')) checks.push('A photo of this window was steep or unclear: check its corners, or measure it by hand.');
  const worst = smallestMeasured(line.measured)?.uncertaintyIn ?? null;
  if (worst !== null && worst > settings.checkUncertaintyIn) {
    checks.push(`The photo measurement could be off by ${fractionInches(worst)} in (more than ${fractionInches(settings.checkUncertaintyIn)} in): take another photo or measure by hand.`);
  }
  const suggestions = line.style === null ? temperedSuggestions({ ...line, style: 'picture' }, order) : temperedSuggestions(line, order);
  if (!line.tempered) for (const s of suggestions) checks.push(s.message);

  const reasons: OrderLineReason[] = [...errors.map((message) => ({ level: 'error' as const, message })), ...checks.map((message) => ({ level: 'check' as const, message }))];
  const status: OrderLineStatus = errors.length > 0 ? 'error' : checks.length > 0 ? 'check' : 'ready';
  return {
    id: line.id,
    status,
    reasons,
    order,
    suggestions,
    specialOrder: line.style !== null && SPECIALTY_STYLES.has(line.style),
    orderable: status === 'ready' || (status === 'check' && line.confirmed),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Grouping and totals                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

export type OrderGroup = {
  /** 1-based line number on the sheet. */
  lineNo: number;
  lineIds: string[];
  locations: string[];
  quantity: number;
  style: WindowStyle;
  widthIn: number;
  heightIn: number;
  frameInterior: FrameColor;
  frameExterior: FrameColor;
  grid: WindowGrid;
  glass: GlassPackage;
  tempered: boolean;
  obscure: boolean;
  screen: ScreenType;
  notes: string;
  specialOrder: boolean;
  unitedIn: number;
  sqFt: number;
};

export type OrderTotals = { windows: number; unitedIn: number; sqFt: number; lines: number; specialOrders: number };

/** The same window built the same way (order size and every option) groups into one sheet line with a quantity. */
export function groupOrderLines(lines: readonly WindowOrderLine[], settings: WindowOrderSettings): { groups: OrderGroup[]; totals: OrderTotals } {
  const groups = new Map<string, OrderGroup>();
  for (const line of lines) {
    const c = checkLine(line, settings);
    if (c.order === null || line.style === null) continue;
    const grid = line.grid.type === 'none' ? { type: 'none' as const, top: '', bottom: '' } : line.grid;
    const key = JSON.stringify([line.style, c.order.widthIn, c.order.heightIn, line.frameInterior, line.frameExterior, grid, line.glass, line.tempered, line.obscure, line.screen, line.notes.trim()]);
    const found = groups.get(key);
    if (found) {
      found.lineIds.push(line.id);
      if (!found.locations.includes(line.location.trim())) found.locations.push(line.location.trim());
      found.quantity += line.quantity;
      continue;
    }
    groups.set(key, {
      lineNo: groups.size + 1,
      lineIds: [line.id],
      locations: [line.location.trim()],
      quantity: line.quantity,
      style: line.style,
      widthIn: c.order.widthIn,
      heightIn: c.order.heightIn,
      frameInterior: line.frameInterior,
      frameExterior: line.frameExterior,
      grid,
      glass: line.glass,
      tempered: line.tempered,
      obscure: line.obscure,
      screen: line.screen,
      notes: line.notes.trim(),
      specialOrder: c.specialOrder,
      unitedIn: c.order.widthIn + c.order.heightIn,
      sqFt: (c.order.widthIn * c.order.heightIn) / 144,
    });
  }
  const list = [...groups.values()];
  const totals: OrderTotals = {
    lines: list.length,
    windows: list.reduce((s, g) => s + g.quantity, 0),
    unitedIn: list.reduce((s, g) => s + g.quantity * g.unitedIn, 0),
    sqFt: Math.round(list.reduce((s, g) => s + g.quantity * g.sqFt, 0) * 100) / 100,
    specialOrders: list.filter((g) => g.specialOrder).reduce((s, g) => s + g.quantity, 0),
  };
  return { groups: list, totals };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* From photo windows to lines                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What a line needs from a photo window (the photo session adds windowKey and uncertaintyIn; both optional here). */
export type OrderSourceWindow = {
  id: string;
  /** Absent for a room-scan window with no photo. */
  uploadId?: string;
  /** How it was measured; 'roomplan' and 'card' are quote-grade (MeasuredSize.quoteOnly). Absent: order-grade. */
  scale?: { kind: string };
  /** 'homeowner-app': the homeowner measured it themselves in the phone app: quote-grade whatever the method. */
  source?: string;
  label?: string;
  /** A homeowner's "Bathroom window?" answered yes: the line starts with obscure (frosted) glass. */
  frosted?: boolean;
  windowKey?: string;
  widthIn: number;
  heightIn: number;
  quality: 'good' | 'check';
  uncertaintyIn?: { width: number; height: number } | null;
};

const keyOf = (w: OrderSourceWindow): string => (w.windowKey !== undefined && w.windowKey !== '' ? w.windowKey : w.id);

/**
 * Lines for a measurement's photo windows: one per window (photos sharing a windowKey are one window). Excluded photos
 * are left out. A line already in `previous` (same window) keeps the person's options; its measurements are refreshed.
 */
export function linesFromPhotoWindows(windows: readonly OrderSourceWindow[], excluded: ReadonlySet<string>, previous: readonly WindowOrderLine[] = []): WindowOrderLine[] {
  const byKey = new Map<string, OrderSourceWindow[]>();
  for (const w of windows) {
    if (excluded.has(w.id)) continue;
    const k = keyOf(w);
    byKey.set(k, [...(byKey.get(k) ?? []), w]);
  }
  const before = new Map(previous.map((l) => [l.id, l]));
  return [...byKey].map(([id, photos], i) => {
    const measured: MeasuredSize[] = photos.map((p) => ({
      widthIn: p.widthIn,
      heightIn: p.heightIn,
      uncertaintyIn: p.uncertaintyIn ?? null,
      quality: p.quality,
      ...((p.scale?.kind === 'roomplan' || p.scale?.kind === 'card' || p.source === 'homeowner-app') && { quoteOnly: true }),
    }));
    const label = photos.find((p) => (p.label ?? '').trim() !== '')?.label?.trim() ?? '';
    const uploadId = photos.find((p) => p.uploadId !== undefined)?.uploadId ?? null;
    const old = before.get(id);
    if (old) return { ...old, photoWindowIds: photos.map((p) => p.id), uploadId, measured, location: old.location !== '' ? old.location : label, lockedSize: null };
    return { id, photoWindowIds: photos.map((p) => p.id), uploadId, location: label !== '' ? label : `Window ${i + 1}`, measured, ...defaultLineOptions(), ...(photos.some((p) => p.frosted === true) && { obscure: true }) };
  });
}

/** Applies a person's edits to lines (by id). Returns null when an edit names a line that is not there. */
export function applyLinePatches(lines: readonly WindowOrderLine[], patches: readonly WindowOrderLinePatch[]): WindowOrderLine[] | null {
  const byId = new Map(lines.map((l) => [l.id, l]));
  for (const p of patches) {
    const line = byId.get(p.id);
    if (!line) return null;
    // The id names the line; everything else in the patch replaces that field.
    byId.set(p.id, { ...line, ...p, id: line.id });
  }
  return lines.map((l) => byId.get(l.id)!);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The API's view                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

export const WINDOW_ORDER_STATUSES = ['draft', 'ready', 'sent'] as const;
export type WindowOrderStatus = (typeof WINDOW_ORDER_STATUSES)[number];

/** GET/PATCH /api/window-orders/:id and POST /api/window-measurements/:id/order. */
export type WindowOrderView = {
  id: string;
  windowMeasurementId: string;
  address: string;
  status: WindowOrderStatus;
  poNumber: string;
  lines: WindowOrderLine[];
  checked: CheckedLine[];
  groups: OrderGroup[];
  totals: OrderTotals;
  settings: WindowOrderSettings;
  /** True when every line is orderable (no errors; 'check' lines confirmed). */
  canMarkReady: boolean;
  /** True when the signed-in member may mark it ready (owner and office). */
  mayMarkReady: boolean;
  readyAt: string | null;
  sentAt: string | null;
  sentBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** PATCH /api/window-orders/:id. */
export type WindowOrderPatch = { poNumber?: string; lines?: WindowOrderLinePatch[] };

/** Everything the view derives from the stored lines and settings. */
export function deriveOrder(lines: readonly WindowOrderLine[], settings: WindowOrderSettings): Pick<WindowOrderView, 'checked' | 'groups' | 'totals' | 'canMarkReady'> {
  const checked = lines.map((l) => checkLine(l, settings));
  const { groups, totals } = groupOrderLines(lines, settings);
  return { checked, groups, totals, canMarkReady: lines.length > 0 && checked.every((c) => c.orderable) };
}

export const MAX_PO_LENGTH = 40;
