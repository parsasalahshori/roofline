// WinChoice back office: the shared contract between the API and the web app (types only, plus the constants they
// need). Office staff and sales reps use it; it is on only for companies with company_settings.backoffice_enabled.
//
// Four parts, one model:
// - Products & pricing: the company's own products (window styles, patio doors), options and accessories, priced by
//   simple rules the office edits (ProductCatalog).
// - Designer: each window or door is drawn like a sketch on a pad: an outer frame split into sections, each section an
//   opening (fixed, sash, slider, casement...) with its grid (WindowDesign). One drawing makes every document.
// - Visualizer: the drawn units placed on a photo of the customer's house by their four corners (HouseVisual).
// - Orders: every sold job moves through ORDER_STAGES; each move can text/email the customer (OrderStageTemplate) and
//   drives the homeowner app's status (HOMEOWNER_STAGE_FOR).
//
// Money is in cents; sizes in inches; photo positions in 0..1 of the photo.
import type { HomeownerStage } from './homeowner.ts';
import type { Tier } from './proposals.ts';
import type { GridType, SafetyAnswers, ScreenType, WindowStyle } from './window-order.ts';

// ---------------------------------------------------------------------------------------------------------------
// Products & pricing
// ---------------------------------------------------------------------------------------------------------------

export const PRODUCT_KINDS = ['window', 'patio-door'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** How one section of a unit opens (seen from outside). */
export const OPENING_KINDS = [
  'fixed', // picture / fixed lite
  'hung-sash', // the two sashes of a hung window, drawn as one section split by the meeting rail
  'slide-left', // slider sash that moves left
  'slide-right',
  'casement-left', // hinged on the left
  'casement-right',
  'awning', // hinged at the top
  'hopper', // hinged at the bottom
  'door-fixed', // patio door fixed panel
  'door-slide-left', // patio door operating panel
  'door-slide-right',
] as const;
export type OpeningKind = (typeof OPENING_KINDS)[number];

/** Outer shape of a unit. */
export const UNIT_SHAPES = ['rect', 'arch-top', 'circle'] as const;
export type UnitShape = (typeof UNIT_SHAPES)[number];

/**
 * How a product is priced, before options. 'united-inch': a price per break of united inches (width + height), the
 * window trade's usual table. 'sq-ft': a rate per square foot with a minimum. Either can differ by tier.
 */
export type PriceRule =
  | { kind: 'united-inch'; breaks: { maxUi: number; cents: Record<Tier, number> }[] }
  | { kind: 'sq-ft'; centsPerSqFt: Record<Tier, number>; minimumCents: Record<Tier, number> };

/** A product the company sells (a window line or a patio door), with what may be drawn and how it is priced. */
export type Product = {
  id: string;
  kind: ProductKind;
  name: string; // "WinChoice 5000 Double Hung"
  description: string;
  /** Openings allowed inside this product's frame (the designer offers only these). */
  openings: OpeningKind[];
  shapes: UnitShape[];
  /** Size limits of one unit (outer frame), inches. */
  limits: { minWidthIn: number; maxWidthIn: number; minHeightIn: number; maxHeightIn: number; maxUnitedIn: number };
  /** Most sections one unit may be split into (e.g. 3 for a 3-lite slider). */
  maxSections: number;
  price: PriceRule;
  /**
   * The factory order style this product is built as (additive to the contract): imports from the factory order map a
   * measured window's style to a product by it, and the safety-glass suggestions use it. A patio door has none.
   */
  factoryStyle?: WindowStyle;
  /** Added per section beyond the first (mullions/extra sashes), by tier. */
  perExtraSectionCents: Record<Tier, number>;
  /** Product off the price sheet and the designer (kept for old quotes). */
  archived: boolean;
};

/** An option chosen per unit; its adder is per unit, per section, per lite (grids) or per sq ft. */
export const OPTION_GROUPS = ['exterior-color', 'interior-color', 'glass', 'grid', 'screen', 'obscure', 'tempered', 'hardware'] as const;
export type OptionGroup = (typeof OPTION_GROUPS)[number];
export type OptionChoice = {
  id: string;
  group: OptionGroup;
  label: string; // "Bronze exterior", "LoE366 + argon", "Colonial grids"
  /** The factory order value this choice stands for, when the group has one (e.g. 'bronze', 'lowe-argon'). */
  value: string;
  adder: { per: 'unit' | 'section' | 'lite' | 'sq-ft'; cents: number };
  /** Products it applies to; empty = all. */
  productIds: string[];
  isDefault: boolean;
  archived: boolean;
};

/** Job-level extras ("From dumpsters to scaffolding..."): per job, per unit or per linear foot of trim. */
export type Accessory = {
  id: string;
  label: string; // "Exterior capping", "Disposal of old windows", "Permit"
  per: 'job' | 'unit' | 'linear-ft';
  cents: number;
  /** Added to every new quote (the person can remove it). */
  autoAdd: boolean;
  archived: boolean;
};

export type TierLabels = Record<Tier, { label: string; note: string }>;

/** The company's whole price book for the back office (company_settings.product_catalog; null = defaults in code). */
export type ProductCatalog = {
  version: number; // bumped on every save; quotes keep the version they were priced with
  products: Product[];
  options: OptionChoice[];
  accessories: Accessory[];
  tiers: TierLabels;
  /** Applied to the total after options and accessories, percent (0 = none). */
  markupPercent: number;
  /** Most a rep may discount without an office approval, percent. */
  maxRepDiscountPercent: number;
};

// ---------------------------------------------------------------------------------------------------------------
// Designer
// ---------------------------------------------------------------------------------------------------------------

/** A grid pattern: lites wide x lites high ("2x2"); '' = none. Same format as the factory order (GRID_PATTERN). */
export type LitePattern = string;

/** One section of a unit: how it opens and its grid. */
export type Section = {
  kind: 'section';
  id: string;
  opening: OpeningKind;
  /** For 'hung-sash' the top and bottom sash patterns ("top/bottom", e.g. "3x2/3x2"); otherwise one pattern. */
  grid: LitePattern;
};

/**
 * The unit's layout: a section, or a split of the space into parts left-to-right ('columns') or top-to-bottom
 * ('rows'). Each part's `size` is inches along the split; the last part takes what is left (size null).
 */
export type Layout = Section | { kind: 'split'; id: string; direction: 'columns' | 'rows'; parts: { size: number | null; layout: Layout }[] };

/** One drawn window or door: what the factory builds and what the customer sees. */
export type WindowDesign = {
  id: string;
  label: string; // the room: "Kitchen", "Primary bed left"
  productId: string;
  quantity: number;
  shape: UnitShape;
  /** Outer frame size, inches (the order size once measured on site). */
  widthIn: number;
  heightIn: number;
  layout: Layout;
  /** Chosen options by group (an OptionChoice id); a missing group takes the product's default. */
  options: Partial<Record<OptionGroup, string>>;
  gridType: GridType;
  screen: ScreenType;
  safety: SafetyAnswers;
  /** Where the size came from: typed by a person, or a measurement (photo window / factory order line). */
  sizeSource: { kind: 'typed' } | { kind: 'measured'; windowMeasurementId: string; lineId: string };
  notes: string;
};

/** A problem the designer shows on a unit ("Too wide for this product: 72 in max"). */
export type DesignIssue = { designId: string; level: 'error' | 'warning'; field: string; message: string };

// ---------------------------------------------------------------------------------------------------------------
// Quotes (one drawing -> every document)
// ---------------------------------------------------------------------------------------------------------------

export type BackofficeQuoteLine = {
  designId: string | null; // null for an accessory line
  accessoryId: string | null;
  description: string; // "Kitchen: Double hung 35 1/2 x 59 1/2, bronze, colonial 3x2"
  quantity: number;
  unitCents: number;
  amountCents: number;
};

export type QuoteTotals = { subtotalCents: number; markupCents: number; discountCents: number; totalCents: number };

export const BACKOFFICE_QUOTE_STATUSES = ['draft', 'presented', 'accepted', 'declined'] as const;
export type BackofficeQuoteStatus = (typeof BACKOFFICE_QUOTE_STATUSES)[number];

/** GET/PUT /api/backoffice/quotes/:id. Prices are recomputed by the server; the browser previews with the same code. */
export type BackofficeQuote = {
  id: string;
  jobId: string;
  customerName: string;
  address: string;
  status: BackofficeQuoteStatus;
  tier: Tier;
  catalogVersion: number;
  designs: WindowDesign[];
  accessories: { accessoryId: string; quantity: number }[];
  discountPercent: number;
  /** Computed: lines per tier (so all three can be shown), the chosen tier's totals, and problems. */
  lines: Record<Tier, BackofficeQuoteLine[]>;
  totals: Record<Tier, QuoteTotals>;
  issues: DesignIssue[];
  /** A discount over the rep's limit waits for an office approval. */
  discountNeedsApproval: boolean;
  /** The order this quote became when it was accepted (additive to the contract); null before. */
  orderId?: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One row of GET /api/backoffice/quotes (additive to the contract). Totals are for the quote's chosen tier. */
export type BackofficeQuoteSummary = {
  id: string;
  jobId: string;
  customerName: string;
  address: string;
  status: BackofficeQuoteStatus;
  tier: Tier;
  units: number;
  totalCents: number;
  orderId: string | null;
  updatedAt: string;
};

/**
 * POST /api/backoffice/quotes (additive to the contract): a new draft quote for a job. With `importMeasured`, the
 * designs start from the job's address's window measurement (`windowMeasurementId`, else its newest): the factory order's
 * lines when it has an order, else the photo windows, each as a design with sizeSource 'measured'.
 */
export type CreateBackofficeQuote = { jobId: string; tier?: Tier; importMeasured?: boolean; windowMeasurementId?: string };

/** PUT /api/backoffice/quotes/:id (additive to the contract). The server recomputes everything else. 'accepted' only comes from POST /:id/accept. */
export type UpdateBackofficeQuote = {
  status?: Exclude<BackofficeQuoteStatus, 'accepted'>;
  tier: Tier;
  designs: WindowDesign[];
  accessories: { accessoryId: string; quantity: number }[];
  discountPercent: number;
};

/** The documents one quote makes: GET /api/backoffice/quotes/:id/documents/:kind (PDF). */
export const QUOTE_DOCUMENTS = ['quote', 'order-confirmation', 'factory-order', 'install-sheet'] as const;
export type QuoteDocument = (typeof QUOTE_DOCUMENTS)[number];

// ---------------------------------------------------------------------------------------------------------------
// Visualizer
// ---------------------------------------------------------------------------------------------------------------

/** A drawn unit placed on the house photo by its four corners (TL, TR, BR, BL; 0..1 of the photo). */
export type Placement = { id: string; designId: string; corners: [[number, number], [number, number], [number, number], [number, number]] };

/** PUT /api/backoffice/quotes/:id/visual. The photo is an upload of the quote's job (served like window uploads). */
export type HouseVisual = { quoteId: string; photoUploadId: string | null; placements: Placement[]; updatedAt: string };

// ---------------------------------------------------------------------------------------------------------------
// Orders: from sold to installed, with customer updates
// ---------------------------------------------------------------------------------------------------------------

export const ORDER_STAGES = [
  'sold', // quote accepted, deposit taken
  'measure-booked', // final measure (remeasure) visit booked
  'measured', // sizes confirmed on site
  'ordered', // factory order released to the plant
  'in-production', // on the line at Mountain Pine
  'built', // finished and checked
  'shipped', // on the truck
  'install-scheduled',
  'installed',
  'complete', // paid, walkthrough signed
] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

/** What the homeowner app shows for each order stage (HOMEOWNER_STAGES). */
export const HOMEOWNER_STAGE_FOR: Readonly<Record<OrderStage, HomeownerStage>> = {
  sold: 'visit-booked',
  'measure-booked': 'visit-booked',
  measured: 'measured',
  ordered: 'ordered',
  'in-production': 'ordered',
  built: 'built',
  shipped: 'shipped',
  'install-scheduled': 'shipped',
  installed: 'installed',
  complete: 'installed',
};

/** A message sent to the customer when an order enters a stage. {first}, {date}, {company} are filled in. */
export type OrderStageTemplate = { stage: OrderStage; enabled: boolean; sms: string; emailSubject: string; emailBody: string };

/** One move on an order's timeline. */
export type OrderEvent = {
  id: string;
  stage: OrderStage;
  at: string;
  byUserName: string | null; // null = automatic
  note: string;
  /** Planned date shown to the customer for this stage (install date, ship date), when known. */
  plannedFor: string | null;
  notified: { sms: 'sent' | 'skipped-no-consent' | 'off' | 'failed'; email: 'sent' | 'off' | 'failed' } | null;
};

/** GET /api/backoffice/orders (board) and /orders/:id. */
export type BackofficeOrder = {
  id: string;
  jobId: string;
  quoteId: string;
  customerName: string;
  address: string;
  stage: OrderStage;
  units: number;
  totalCents: number;
  /** Days in the current stage, for the board's "stuck" marker. */
  daysInStage: number;
  /** The factory order sheet this order released (window_orders), when released. */
  windowOrderId: string | null;
  events: OrderEvent[];
};

/** PATCH /api/backoffice/orders/:id/stage. */
export type OrderStageMove = { stage: OrderStage; note: string; plannedFor: string | null; notify: boolean };

/** Company back-office settings (company_settings.backoffice): templates and stuck thresholds. */
export type BackofficeSettings = {
  templates: OrderStageTemplate[];
  /** Days in a stage before the board marks the order stuck. */
  stuckDays: Partial<Record<OrderStage, number>>;
};
