/*
 * The Prices settings tab (C1 Task 25). Money is in dollars on screen; the server stores the same
 * numbers. Field keys match the pricebook keys in `pricebookSchema`, and the defaults keys match
 * the quote defaults.
 */
export const prices = {
  title: 'Prices',
  loading: 'Loading prices…',
  loadFailed: 'Prices could not be loaded.',
  save: 'Save prices',
  saved: 'Prices saved.',
  ownerOnly: 'Only the owner can change prices.',
  exampleBanner: 'Example prices — set your own.',

  groups: {
    materials: 'Materials',
    labor: 'Labor',
    perFoot: 'Per foot',
    other: 'Other',
    defaults: 'Quote defaults',
  },

  /** Each dollar field's label. */
  fields: {
    architecturalBundle: 'Architectural bundle',
    premiumBundle: 'Designer bundle',
    metalPerSquare: 'Metal roofing',
    laborPerSquare: 'Labor',
    metalLaborPerSquare: 'Metal labor',
    tearoffPerSquare: 'Tear-off',
    steepPerSquare: 'Steep roof',
    heightPerSquare: 'Extra story',
    ridgePerFt: 'Ridge and hip cap',
    edgePerFt: 'Drip edge',
    valleyPerFt: 'Valley',
    underlaymentPerSquare: 'Underlayment',
    deckingPerSheet: 'Decking',
    disposal: 'Disposal and cleanup',
    permit: 'Permit',
    wastePercent: 'Waste',
    markupPercent: 'Markup',
    taxPercent: 'Sales tax',
    material: 'Default material',
  },

  /** Unit help under a field. */
  units: {
    perBundle: 'per bundle',
    perSquare: 'per square',
    perFoot: 'per foot',
    perSheet: 'per sheet',
    perJob: 'per job',
    percent: 'percent',
  },

  /** The default material choices. */
  materialOptions: {
    architectural: 'Architectural shingles',
    premium: 'Designer shingles',
    metal: 'Standing seam metal',
  },
} as const;
