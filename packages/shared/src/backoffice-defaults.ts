// WinChoice back office: the defaults a company starts with, until its owner edits the price book and the messages.
//
// !!! EVERY PRICE IN THIS FILE IS A PLACEHOLDER. !!!
// They are realistic for a factory-direct vinyl replacement window in the middle of the US, so a demo reads right, but they
// are NOT WinChoice's prices. The owner replaces them (PUT /api/backoffice/catalog) before the first real quote.
// The size limits follow DEFAULT_STYLE_LIMITS in window-order.ts, which are also typical ranges, not Mountain Pine's.
import type { Accessory, BackofficeSettings, OptionChoice, OrderStageTemplate, Product, ProductCatalog } from './backoffice.ts';
import { ORDER_STAGES, type OrderStage } from './backoffice.ts';
import type { Tier } from './proposals.ts';

/** Good / better / best from one "good" number: better is 14% more, best 30% more, to the nearest dollar. */
const ladder = (good: number): Record<Tier, number> => ({ good, better: Math.round((good * 1.14) / 100) * 100, best: Math.round((good * 1.3) / 100) * 100 });
const flat = (cents: number): Record<Tier, number> => ({ good: cents, better: cents, best: cents });

/** United-inch breaks (width + height) with the "good" price per break; the other tiers follow the ladder. PLACEHOLDER PRICES. */
const unitedInchPrice = (table: [maxUi: number, goodCents: number][]): Product['price'] => ({
  kind: 'united-inch',
  breaks: table.map(([maxUi, good]) => ({ maxUi, cents: ladder(good) })),
});

const WINDOW_OPENINGS = { hung: ['hung-sash'], fixed: ['fixed'] } as const;

export const DEFAULT_PRODUCTS: Product[] = [
  {
    id: 'wc-double-hung',
    kind: 'window',
    name: 'WinChoice Double Hung',
    description: 'Both sashes tilt in to clean. The replacement window most homes need.',
    openings: [...WINDOW_OPENINGS.hung],
    shapes: ['rect'],
    limits: { minWidthIn: 14, maxWidthIn: 48, minHeightIn: 20, maxHeightIn: 84, maxUnitedIn: 120 },
    maxSections: 1,
    price: unitedInchPrice([[60, 31500], [70, 34500], [80, 37500], [90, 41000], [100, 44500], [110, 48500], [120, 53000]]),
    factoryStyle: 'double-hung',
    perExtraSectionCents: flat(0),
    archived: false,
  },
  {
    id: 'wc-single-hung',
    kind: 'window',
    name: 'WinChoice Single Hung',
    description: 'Fixed top sash, tilt-in bottom sash. A lower price than the double hung.',
    openings: [...WINDOW_OPENINGS.hung],
    shapes: ['rect'],
    limits: { minWidthIn: 14, maxWidthIn: 48, minHeightIn: 20, maxHeightIn: 84, maxUnitedIn: 120 },
    maxSections: 1,
    price: unitedInchPrice([[60, 27500], [70, 30000], [80, 32500], [90, 35500], [100, 38500], [110, 42000], [120, 46000]]),
    factoryStyle: 'single-hung',
    perExtraSectionCents: flat(0),
    archived: false,
  },
  {
    id: 'wc-slider-2',
    kind: 'window',
    name: 'WinChoice 2-Lite Slider',
    description: 'Two sashes side by side; one or both slide.',
    openings: ['slide-left', 'slide-right', 'fixed'],
    shapes: ['rect'],
    limits: { minWidthIn: 18, maxWidthIn: 84, minHeightIn: 12, maxHeightIn: 60, maxUnitedIn: 132 },
    maxSections: 2,
    price: unitedInchPrice([[60, 33000], [72, 37000], [84, 41500], [96, 46500], [108, 52000], [132, 59500]]),
    factoryStyle: 'slider-2',
    perExtraSectionCents: flat(0),
    archived: false,
  },
  {
    id: 'wc-slider-3',
    kind: 'window',
    name: 'WinChoice 3-Lite Slider',
    description: 'Three lites: a fixed center with a sliding sash on each side, or the reverse.',
    openings: ['slide-left', 'slide-right', 'fixed'],
    shapes: ['rect'],
    limits: { minWidthIn: 48, maxWidthIn: 120, minHeightIn: 12, maxHeightIn: 60, maxUnitedIn: 160 },
    maxSections: 3,
    price: unitedInchPrice([[84, 52000], [96, 58000], [108, 65000], [120, 72500], [140, 82000], [160, 93000]]),
    factoryStyle: 'slider-3',
    perExtraSectionCents: flat(0),
    archived: false,
  },
  {
    id: 'wc-picture',
    kind: 'window',
    name: 'WinChoice Picture Window',
    description: 'Fixed glass, no moving parts. The best view and the lowest air leakage.',
    openings: ['fixed'],
    shapes: ['rect'],
    limits: { minWidthIn: 12, maxWidthIn: 96, minHeightIn: 12, maxHeightIn: 96, maxUnitedIn: 168 },
    maxSections: 1,
    price: { kind: 'sq-ft', centsPerSqFt: ladder(1650), minimumCents: ladder(17500) },
    factoryStyle: 'picture',
    perExtraSectionCents: flat(0),
    archived: false,
  },
  {
    id: 'wc-casement',
    kind: 'window',
    name: 'WinChoice Casement',
    description: 'Cranks open to the side. One leaf, or a pair side by side.',
    openings: ['casement-left', 'casement-right', 'fixed'],
    shapes: ['rect'],
    limits: { minWidthIn: 14, maxWidthIn: 72, minHeightIn: 20, maxHeightIn: 72, maxUnitedIn: 130 },
    maxSections: 2,
    price: { kind: 'sq-ft', centsPerSqFt: ladder(2250), minimumCents: ladder(29500) },
    factoryStyle: 'casement',
    perExtraSectionCents: ladder(4500),
    archived: false,
  },
  {
    id: 'wc-awning',
    kind: 'window',
    name: 'WinChoice Awning',
    description: 'Hinged at the top and cranks out; stays open in light rain.',
    openings: ['awning', 'hopper', 'fixed'],
    shapes: ['rect'],
    limits: { minWidthIn: 18, maxWidthIn: 48, minHeightIn: 12, maxHeightIn: 36, maxUnitedIn: 80 },
    maxSections: 1,
    price: { kind: 'sq-ft', centsPerSqFt: ladder(2400), minimumCents: ladder(27500) },
    factoryStyle: 'awning',
    perExtraSectionCents: flat(0),
    archived: false,
  },
  {
    id: 'wc-arch-top',
    kind: 'window',
    name: 'WinChoice Arch Top (specialty)',
    description: 'A fixed window with a curved top. Always a special order at the factory.',
    openings: ['fixed'],
    shapes: ['arch-top'],
    limits: { minWidthIn: 12, maxWidthIn: 96, minHeightIn: 12, maxHeightIn: 96, maxUnitedIn: 130 },
    maxSections: 1,
    price: { kind: 'sq-ft', centsPerSqFt: ladder(3600), minimumCents: ladder(52500) },
    factoryStyle: 'arch',
    perExtraSectionCents: flat(0),
    archived: false,
  },
  {
    id: 'wc-patio-door',
    kind: 'patio-door',
    name: 'WinChoice 2-Panel Patio Door',
    description: 'A sliding vinyl patio door: one fixed panel and one that slides.',
    openings: ['door-fixed', 'door-slide-left', 'door-slide-right'],
    shapes: ['rect'],
    limits: { minWidthIn: 60, maxWidthIn: 72, minHeightIn: 78, maxHeightIn: 96, maxUnitedIn: 168 },
    maxSections: 2,
    price: unitedInchPrice([[144, 124500], [152, 132000], [160, 139500], [168, 148000]]),
    perExtraSectionCents: flat(0),
    archived: false,
  },
];

const option = (
  id: string,
  group: OptionChoice['group'],
  label: string,
  value: string,
  adder: OptionChoice['adder'],
  isDefault = false,
): OptionChoice => ({ id, group, label, value, adder, productIds: [], isDefault, archived: false });

const unit = (cents: number): OptionChoice['adder'] => ({ per: 'unit', cents });

/** PLACEHOLDER adders. The frame colors are laminates; white is the standard. */
const COLOR_ADDERS: [value: string, label: string, exterior: number, interior: number][] = [
  ['white', 'White', 0, 0],
  ['almond', 'Almond', 0, 0],
  ['clay', 'Clay', 4500, 2500],
  ['bronze', 'Bronze', 6500, 3500],
  ['black', 'Black', 6500, 3500],
  ['woodgrain', 'Woodgrain', 12500, 9500],
];

export const DEFAULT_OPTIONS: OptionChoice[] = [
  ...COLOR_ADDERS.map(([value, label, exterior]) => option(`ext-${value}`, 'exterior-color', `${label} exterior`, value, unit(exterior), value === 'white')),
  ...COLOR_ADDERS.map(([value, label, , interior]) => option(`int-${value}`, 'interior-color', `${label} interior`, value, unit(interior), value === 'white')),
  option('glass-lowe-argon', 'glass', 'Cardinal LoE366 + argon (dual pane)', 'lowe-argon', unit(0), true),
  option('glass-triple', 'glass', 'Triple pane LoE366 + argon', 'triple-lowe-argon', { per: 'sq-ft', cents: 350 }),
  option('grid-none', 'grid', 'No grids', 'none', unit(0), true),
  option('grid-colonial', 'grid', 'Colonial grids', 'colonial', { per: 'lite', cents: 350 }),
  option('grid-prairie', 'grid', 'Prairie grids', 'prairie', { per: 'lite', cents: 450 }),
  option('grid-custom', 'grid', 'Custom grids (special order)', 'custom', unit(9500)),
  option('screen-none', 'screen', 'No screen', 'none', unit(0)),
  option('screen-half', 'screen', 'Half screen', 'half', unit(0), true),
  option('screen-full', 'screen', 'Full screen', 'full', unit(1800)),
  option('obscure', 'obscure', 'Obscure (frosted) glass', 'obscure', unit(4500)),
  option('tempered', 'tempered', 'Tempered safety glass', 'tempered', { per: 'sq-ft', cents: 450 }),
  option('hardware-black', 'hardware', 'Black locks and hardware', 'black-hardware', unit(1500)),
];

export const DEFAULT_ACCESSORIES: Accessory[] = [
  { id: 'acc-capping', label: 'Exterior capping', per: 'unit', cents: 18500, autoAdd: true, archived: false },
  { id: 'acc-disposal', label: 'Disposal of old windows', per: 'unit', cents: 3500, autoAdd: true, archived: false },
  { id: 'acc-permit', label: 'Permit', per: 'job', cents: 25000, autoAdd: false, archived: false },
  { id: 'acc-trim', label: 'Interior stool and trim', per: 'linear-ft', cents: 450, autoAdd: false, archived: false },
];

/** The company's price book until it saves its own. Version 0: never saved. */
export const DEFAULT_PRODUCT_CATALOG: ProductCatalog = {
  version: 0,
  products: DEFAULT_PRODUCTS,
  options: DEFAULT_OPTIONS,
  accessories: DEFAULT_ACCESSORIES,
  tiers: {
    good: { label: 'Good', note: 'Select series: solid vinyl, dual pane glass' },
    better: { label: 'Better', note: 'Preferred series: the series most customers choose' },
    best: { label: 'Best', note: 'Signature series: our finest frame and hardware' },
  },
  markupPercent: 0,
  maxRepDiscountPercent: 10,
};

/** A company's stored price book (or null for none): a copy, so callers may change it. */
export function resolveProductCatalog(stored: ProductCatalog | null | undefined): ProductCatalog {
  return structuredClone(stored ?? DEFAULT_PRODUCT_CATALOG);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Customer messages per order stage                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Short and warm, written to be read on a phone. {first} is the customer's first name, {company} the company's name and
 * {date} the planned date for the stage (a sentence that needs a date reads fine without one: see STAGE_DATE_FALLBACK).
 */
const TEXTS: Record<OrderStage, { sms: string; subject: string; body: string }> = {
  sold: {
    sms: 'Hi {first}, thank you for choosing {company}! Your order is in. Next we will book a final measure visit. Questions? Just reply here.',
    subject: 'Thank you for your order',
    body: 'Hi {first},\n\nThank you for choosing {company}. Your windows are officially on order with us.\n\nNext step: we will book a final measure visit so every window is built to fit. We will reach out with a date.\n\nIf you have any questions, just reply to this email.\n\n{company}',
  },
  'measure-booked': {
    sms: 'Hi {first}, your final measure visit is booked: {date}. We will measure every window so they fit perfectly. See you then!',
    subject: 'Your measure visit is booked',
    body: 'Hi {first},\n\nYour final measure visit is booked: {date}.\n\nWe will measure each opening carefully so your windows are built to fit. It usually takes under an hour. Please make sure we can reach the windows.\n\n{company}',
  },
  measured: {
    sms: 'Hi {first}, we have your final measurements. Next we send your order to the factory. We will let you know when it is on the line.',
    subject: 'Your windows are measured',
    body: 'Hi {first},\n\nThanks for having us out. We have your final measurements.\n\nNext we release your order to the factory. We will tell you as soon as it is in production.\n\n{company}',
  },
  ordered: {
    sms: 'Hi {first}, good news: your windows have been ordered from the factory. We will keep you posted.',
    subject: 'Your windows are ordered',
    body: 'Hi {first},\n\nYour windows have been ordered from the factory. Every size and option was checked before we sent it.\n\nWe will keep you posted at each step.\n\n{company}',
  },
  'in-production': {
    sms: 'Hi {first}, your windows are being built right now. We will text you when they are finished.',
    subject: 'Your windows are in production',
    body: 'Hi {first},\n\nYour windows are on the line at the factory right now.\n\nWe will let you know the moment they are finished and checked.\n\n{company}',
  },
  built: {
    sms: 'Hi {first}, your windows are built and checked. Next they ship to us. Install day is {date}.',
    subject: 'Your windows are built',
    body: 'Hi {first},\n\nYour windows are built and have passed their quality check.\n\nInstall day: {date}.\n\n{company}',
  },
  shipped: {
    sms: 'Hi {first}, your windows are on the truck. Delivery is {date}. We will confirm your install day shortly.',
    subject: 'Your windows are on the way',
    body: 'Hi {first},\n\nYour windows are on the truck.\n\nDelivery: {date}.\n\nWe will confirm your install day shortly.\n\n{company}',
  },
  'install-scheduled': {
    sms: 'Hi {first}, your install is scheduled: {date}. Please clear the area around each window. Reply here with any questions.',
    subject: 'Your install day is scheduled',
    body: 'Hi {first},\n\nYour install day is scheduled: {date}.\n\nPlease move furniture and curtains back from each window and make sure our crew can reach them. A crew leader will call before they arrive.\n\n{company}',
  },
  installed: {
    sms: 'Hi {first}, your new windows are in! Thank you for trusting {company}. We will do a quick walkthrough with you to make sure you love them.',
    subject: 'Your new windows are installed',
    body: 'Hi {first},\n\nYour new windows are installed. Thank you for trusting {company}.\n\nWe will do a quick walkthrough with you to make sure everything is just right.\n\n{company}',
  },
  complete: {
    sms: 'Hi {first}, all done! Thank you for choosing {company}. If anything ever needs a look, just reply here and we will take care of it.',
    subject: 'All done: thank you',
    body: 'Hi {first},\n\nYour project is complete and the walkthrough is signed. Thank you for choosing {company}.\n\nIf anything ever needs a look, just reply to this email and we will take care of it.\n\n{company}',
  },
};

/** What {date} reads as when the stage has no planned date. */
export const STAGE_DATE_FALLBACK = 'still being set';

/** Days an order may sit in each stage before the board marks it stuck. A missing stage is never stuck. */
const STUCK: Partial<Record<OrderStage, number>> = {
  sold: 3,
  'measure-booked': 10,
  measured: 3,
  ordered: 3,
  'in-production': 28,
  built: 3,
  shipped: 7,
  'install-scheduled': 21,
  installed: 7,
};

/** The messages and stuck days a company starts with. */
export const DEFAULT_BACKOFFICE_SETTINGS: BackofficeSettings = {
  templates: ORDER_STAGES.map(
    (stage): OrderStageTemplate => ({ stage, enabled: true, sms: TEXTS[stage].sms, emailSubject: TEXTS[stage].subject, emailBody: TEXTS[stage].body }),
  ),
  stuckDays: STUCK,
};

/** A company's stored settings laid over the defaults: a template it did not store (or a new stage) uses the default. */
export function resolveBackofficeSettings(stored: Partial<BackofficeSettings> | null | undefined): BackofficeSettings {
  const base = structuredClone(DEFAULT_BACKOFFICE_SETTINGS);
  if (!stored) return base;
  const templates = base.templates.map((t) => stored.templates?.find((s) => s.stage === t.stage) ?? t);
  return { templates, stuckDays: { ...base.stuckDays, ...(stored.stuckDays ?? {}) } };
}

/** Fills {first}, {date} and {company} in a template. Values go in literally; an unknown {token} is left alone. */
export function renderStageText(text: string, values: { first: string; date: string | null; company: string }): string {
  return text.replace(/\{(first|date|company)\}/g, (_m, k: 'first' | 'date' | 'company') => (k === 'date' ? (values.date ?? STAGE_DATE_FALLBACK) : values[k]));
}
