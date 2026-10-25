import {
  backofficeOrderEvents,
  backofficeOrders,
  backofficeQuotes,
  createCustomer,
  createJob,
  createProperty,
  getProductCatalog,
  setBackofficeEnabled,
  withTenant,
  type Pools,
  type TenantContext,
} from '@roofline/db';
import {
  autoAccessories,
  layoutForStyle,
  NO_SAFETY_ANSWERS,
  ORDER_STAGES,
  priceQuote,
  totalUnits,
  type Layout,
  type LngLat,
  type OrderEvent,
  type OrderStage,
  type ProductCatalog,
  type Tier,
  type WindowDesign,
} from '@roofline/shared';
import { importMeasuredDesigns } from '../backoffice/import-measured.ts';

/*
 * The back office for the WinChoice demo: the switch on, quotes with drawn units (a draft built from the measured Ridgeway windows, a
 * presented one, one with a discount that needs the office), and ten orders, one in each stage, with their timelines. Three
 * orders belong to jobs the demo already has (Sheila Moody, Gary Voss, Janet Holloway); seven are new won jobs, because the other
 * twelve jobs are mid-pipeline and a job that is not won has no order. All prices are the default catalog's placeholders.
 * Everything is invented (.test emails, 555 numbers).
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

type UnitSpec = { label: string; product: string; w: number; h: number; qty?: number; ext?: string; int?: string; grid?: [string, string] | string; gridType?: WindowDesign['gridType']; screen?: WindowDesign['screen']; glass?: string; tempered?: boolean; notes?: string; safety?: boolean };

const STYLE_OF: Record<string, Parameters<typeof layoutForStyle>[0]> = {
  'wc-double-hung': 'double-hung',
  'wc-single-hung': 'single-hung',
  'wc-slider-2': 'slider-2',
  'wc-slider-3': 'slider-3',
  'wc-picture': 'picture',
  'wc-casement': 'casement',
  'wc-awning': 'awning',
  'wc-arch-top': 'arch',
};

function design(id: string, u: UnitSpec): WindowDesign {
  const grid = u.grid === undefined ? { top: '', bottom: '' } : typeof u.grid === 'string' ? { top: u.grid, bottom: u.grid } : { top: u.grid[0], bottom: u.grid[1] };
  let layout: Layout;
  if (u.product === 'wc-patio-door') {
    layout = { kind: 'split', id: 'root', direction: 'columns', parts: [{ size: u.w / 2, layout: { kind: 'section', id: 's1', opening: 'door-fixed', grid: grid.top } }, { size: null, layout: { kind: 'section', id: 's2', opening: 'door-slide-left', grid: grid.bottom } }] };
  } else layout = layoutForStyle(STYLE_OF[u.product] ?? 'picture', u.w, grid);
  const options: WindowDesign['options'] = { 'exterior-color': u.ext ?? 'ext-white', 'interior-color': u.int ?? 'int-white' };
  if (u.glass !== undefined) options.glass = u.glass;
  if (u.tempered === true) options.tempered = 'tempered';
  return {
    id,
    label: u.label,
    productId: u.product,
    quantity: u.qty ?? 1,
    shape: u.product === 'wc-arch-top' ? 'arch-top' : 'rect',
    widthIn: u.w,
    heightIn: u.h,
    layout,
    options,
    gridType: u.gridType ?? (u.grid === undefined ? 'none' : 'colonial'),
    screen: u.screen ?? 'half',
    safety: u.safety === true ? { besideDoor: true, wetArea: null, sillHeightIn: 24, walkway: null } : { ...NO_SAFETY_ANSWERS },
    sizeSource: { kind: 'typed' },
    notes: u.notes ?? '',
  };
}

const designs = (prefix: string, units: UnitSpec[]): WindowDesign[] => units.map((u, i) => design(`${prefix}${i + 1}`, u));

const KITS: Record<'a' | 'b' | 'c' | 'd' | 'e', UnitSpec[]> = {
  a: [
    { label: 'Living room front', product: 'wc-double-hung', w: 35.5, h: 59.5, qty: 2, ext: 'ext-bronze', grid: '3x2' },
    { label: 'Bedrooms', product: 'wc-double-hung', w: 29.5, h: 47.5, qty: 3, ext: 'ext-bronze', grid: '3x2' },
    { label: 'Dining room', product: 'wc-picture', w: 60, h: 48, ext: 'ext-bronze', glass: 'glass-triple' },
    { label: 'Kitchen', product: 'wc-slider-2', w: 48, h: 36, ext: 'ext-bronze' },
  ],
  b: [
    { label: 'Family room', product: 'wc-slider-3', w: 96, h: 48, ext: 'ext-white', gridType: 'prairie', grid: ['4x3', '4x3'] },
    { label: 'Upstairs', product: 'wc-double-hung', w: 32, h: 54, qty: 6, grid: '2x2' },
    { label: 'Bathroom', product: 'wc-awning', w: 30, h: 24, ext: 'ext-white' },
  ],
  c: [
    { label: 'Back patio door', product: 'wc-patio-door', w: 72, h: 80, ext: 'ext-black', int: 'int-white' },
    { label: 'Beside the door', product: 'wc-double-hung', w: 24, h: 60, ext: 'ext-black', tempered: true, safety: true },
    { label: 'Kitchen', product: 'wc-double-hung', w: 36, h: 48, qty: 2, ext: 'ext-black' },
  ],
  d: [
    { label: 'Foyer arch', product: 'wc-arch-top', w: 36, h: 30, ext: 'ext-clay' },
    { label: 'Front room', product: 'wc-picture', w: 72, h: 54, ext: 'ext-clay' },
    { label: 'Bedroom pair', product: 'wc-casement', w: 48, h: 48, ext: 'ext-clay' },
  ],
  e: [
    { label: 'All windows', product: 'wc-single-hung', w: 34, h: 52, qty: 8, ext: 'ext-almond', int: 'int-almond' },
    { label: 'Garage side', product: 'wc-slider-2', w: 60, h: 36, ext: 'ext-almond', int: 'int-almond' },
  ],
};

type PlacedKit = { kit: keyof typeof KITS; tier: Tier };
type OrderSeed = {
  stage: OrderStage;
  /** Days the order has been in this stage. */
  inStage: number;
  kit: PlacedKit;
  /** An existing demo job (by address), else a new won job. */
  existing?: string;
  newJob?: { name: string; phone: string; address: string; city: string; zip: string; location: LngLat; email: string };
  /** The date the customer was given for the stage, days from today. */
  plannedInDays?: number;
  /** The customer did not agree to texts (the board shows the skipped result). */
  noTexts?: boolean;
  note?: string;
};

export const WINCHOICE_BACKOFFICE_ORDERS: readonly OrderSeed[] = [
  { stage: 'sold', inStage: 5, kit: { kit: 'a', tier: 'better' }, newJob: { name: 'Priscilla Dunn', phone: '+15015550301', address: '4310 Hillcrest Ave', city: 'Little Rock', zip: '72205', location: [-92.3112, 34.7469], email: 'priscilla.dunn@example.test' } },
  { stage: 'measure-booked', inStage: 2, kit: { kit: 'b', tier: 'good' }, plannedInDays: 3, newJob: { name: 'Marvin Oakes', phone: '+15015550302', address: '17 Edgehill Rd', city: 'Little Rock', zip: '72207', location: [-92.3301, 34.7392], email: 'marvin.oakes@example.test' } },
  { stage: 'measured', inStage: 1, kit: { kit: 'c', tier: 'best' }, newJob: { name: 'Nadine Frazier', phone: '+15015550303', address: '8801 Chenal Pkwy', city: 'Little Rock', zip: '72223', location: [-92.4412, 34.7601], email: 'nadine.frazier@example.test' }, noTexts: true },
  { stage: 'ordered', inStage: 2, kit: { kit: 'a', tier: 'better' }, existing: '5411 W 12th St' },
  { stage: 'in-production', inStage: 16, kit: { kit: 'd', tier: 'better' }, newJob: { name: 'Leon Whitfield', phone: '+15015550304', address: '3200 Cantrell Rd', city: 'Little Rock', zip: '72202', location: [-92.2934, 34.7552], email: 'leon.whitfield@example.test' } },
  { stage: 'built', inStage: 4, kit: { kit: 'e', tier: 'good' }, plannedInDays: 9, newJob: { name: 'Gloria Pace', phone: '+15015550305', address: '1244 Cumberland St', city: 'Little Rock', zip: '72202', location: [-92.2663, 34.7388], email: 'gloria.pace@example.test' } },
  { stage: 'shipped', inStage: 1, kit: { kit: 'b', tier: 'better' }, plannedInDays: 2, newJob: { name: 'Harold Tisdale', phone: '+15015550306', address: '602 N Palm St', city: 'Little Rock', zip: '72205', location: [-92.3377, 34.7555], email: 'harold.tisdale@example.test' } },
  { stage: 'install-scheduled', inStage: 3, kit: { kit: 'c', tier: 'better' }, plannedInDays: 1, existing: '2208 Willow St' },
  { stage: 'installed', inStage: 8, kit: { kit: 'a', tier: 'good' }, note: 'Walkthrough waiting on the final payment.', newJob: { name: 'Rosalind Meeks', phone: '+15015550307', address: '911 Park Ave', city: 'Little Rock', zip: '72204', location: [-92.3523, 34.7231], email: 'rosalind.meeks@example.test' } },
  { stage: 'complete', inStage: 20, kit: { kit: 'e', tier: 'better' }, existing: '1105 Main St' },
];

const STAGE_NOTES: Partial<Record<OrderStage, string>> = {
  sold: 'Quote accepted. Deposit taken.',
  'measure-booked': 'Final measure visit booked.',
  measured: 'All sizes confirmed on site.',
  ordered: 'Factory order released to Mountain Pine.',
  'in-production': 'On the line.',
  built: 'Built and checked.',
  shipped: 'On the truck.',
  'install-scheduled': 'Crew scheduled.',
  installed: 'Installed.',
  complete: 'Paid. Walkthrough signed.',
};

/** Turns the back office on for the demo company and seeds its quotes and orders. Idempotent: a company with quotes keeps them. */
export async function seedWinChoiceBackoffice(
  pools: Pools,
  ctx: TenantContext,
  now: Date,
  made: Record<string, { jobId: string; customerId: string; propertyId: string }>,
  people: { office: string; owner: string },
): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  await withTenant(pools, ctx, async (tx) => {
    const already = await tx.select({ id: backofficeQuotes.id }).from(backofficeQuotes).limit(1);
    if (already.length > 0) {
      await setBackofficeEnabled(tx, ctx, true, now);
      return;
    }
    await setBackofficeEnabled(tx, ctx, true, now);
    const catalog: ProductCatalog = await getProductCatalog(tx, ctx);
    const addQuote = async (jobId: string, o: { status: 'draft' | 'presented' | 'accepted'; tier: Tier; designs: WindowDesign[]; discountPercent?: number; at: Date; accessories?: { accessoryId: string; quantity: number }[] }) => {
      const [row] = await tx
        .insert(backofficeQuotes)
        .values({
          companyId: ctx.companyId,
          jobId,
          status: o.status,
          tier: o.tier,
          catalogVersion: catalog.version,
          designs: o.designs,
          accessories: o.accessories ?? autoAccessories(catalog),
          discountPercent: o.discountPercent ?? 0,
          catalogSnapshot: o.status === 'accepted' ? catalog : null,
          createdByUserId: people.office,
          createdAt: o.at,
          updatedAt: o.at,
        })
        .returning();
      return row!;
    };

    // Open quotes on jobs still in the pipeline.
    const frank = made['305 Ridgeway Dr']!;
    const imported = await importMeasuredDesigns(tx, ctx, frank.propertyId, undefined, catalog, now);
    await addQuote(frank.jobId, { status: 'draft', tier: 'better', designs: 'designs' in imported ? imported.designs : [], at: ago(3 * HOUR) });
    await addQuote(made['2417 N Tyler St']!.jobId, { status: 'presented', tier: 'better', designs: designs('p', KITS.a), accessories: [...autoAccessories(catalog), { accessoryId: 'acc-permit', quantity: 1 }], at: ago(2 * DAY) });
    await addQuote(made['1821 Rodney Parham Rd']!.jobId, { status: 'draft', tier: 'best', designs: designs('r', KITS.b), discountPercent: 12, at: ago(DAY) });

    // The orders: an accepted quote each, and the timeline up to its stage.
    let n = 0;
    for (const seed of WINCHOICE_BACKOFFICE_ORDERS) {
      n += 1;
      const daysAgoJob = 40 + n;
      const units = designs(`o${n}-`, KITS[seed.kit.kit]);
      const priced = priceQuote({ designs: units, accessories: autoAccessories(catalog), discountPercent: 0 }, catalog);
      const total = priced.totals[seed.kit.tier].totalCents;
      let ref = seed.existing !== undefined ? made[seed.existing]! : null;
      if (ref === null) {
        const j = seed.newJob!;
        const [first, ...rest] = j.name.split(' ');
        const customer = await createCustomer(tx, ctx, { displayName: j.name, firstName: first ?? j.name, lastName: rest.join(' ') || null, phones: [{ e164: j.phone, label: 'mobile', primary: true }], emails: [j.email], smsConsentStatus: seed.noTexts === true ? 'none' : 'express' }, { now: ago(daysAgoJob * DAY) });
        const property = await createProperty(tx, ctx, { customerId: customer.id, addressLine: j.address, city: j.city, state: 'AR', zip: j.zip, location: j.location }, { now: ago(daysAgoJob * DAY) });
        const job = await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id, stage: seed.stage === 'installed' || seed.stage === 'complete' ? 'installed' : 'won', source: 'manual', valueCents: total, assignedUserId: null }, { now: ago(daysAgoJob * DAY) });
        ref = { jobId: job.id, customerId: customer.id, propertyId: property.id };
      }
      const stageIndex = ORDER_STAGES.indexOf(seed.stage);
      const enteredAt = ago(seed.inStage * DAY + HOUR);
      const soldAt = ago((seed.inStage + stageIndex * 3 + 2) * DAY);
      const quote = await addQuote(ref.jobId, { status: 'accepted', tier: seed.kit.tier, designs: units, at: soldAt });
      const [order] = await tx
        .insert(backofficeOrders)
        .values({ companyId: ctx.companyId, jobId: ref.jobId, quoteId: quote.id, stage: seed.stage, stageChangedAt: enteredAt, units: totalUnits(units), totalCents: total, createdAt: soldAt, updatedAt: enteredAt })
        .returning();
      // One event per stage up to the current one, spread between the sale and the day it entered its stage.
      const span = enteredAt.getTime() - soldAt.getTime();
      for (let k = 0; k <= stageIndex; k++) {
        const stage = ORDER_STAGES[k]!;
        const at = k === stageIndex ? enteredAt : new Date(soldAt.getTime() + (span * k) / Math.max(1, stageIndex));
        const planned = k === stageIndex && seed.plannedInDays !== undefined ? new Date(now.getTime() + seed.plannedInDays * DAY).toISOString().slice(0, 10) : null;
        const notified: OrderEvent['notified'] = k === 0 ? null : seed.noTexts === true ? { sms: 'skipped-no-consent', email: 'sent' } : { sms: 'sent', email: 'sent' };
        await tx.insert(backofficeOrderEvents).values({
          companyId: ctx.companyId,
          orderId: order!.id,
          stage,
          byUserId: k === 0 ? people.owner : people.office,
          note: k === stageIndex && seed.note !== undefined ? seed.note : (STAGE_NOTES[stage] ?? ''),
          plannedFor: planned,
          notified,
          createdAt: at,
        });
      }
    }
  });
}
