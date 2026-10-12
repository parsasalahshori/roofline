/** Words of the Good, Better, Best templates editor in Settings, Prices. Shared words are in tiers.ts. */
export const tierEditor = {
  title: 'Good, Better, Best',
  /** The line under the heading */
  intro: 'These three options go on every proposal. Each one has its own materials, add-ons and highlights.',
  /** The accessible name of each option's region */
  regionLabels: {
    good: 'Good option',
    better: 'Better option',
    best: 'Best option',
  },
  tierLabels: {
    good: 'Good',
    better: 'Better',
    best: 'Best',
  },
  fields: {
    name: 'Option name',
    material: 'Material',
    waste: 'Waste (%)',
    markup: 'Markup (%)',
    enabled: 'Offer this option',
    addOns: 'Add-ons',
    addOnName: 'Add-on name',
    addOnUnit: 'Unit',
    addOnRate: 'Rate ($)',
    taxable: 'Taxable',
    highlights: 'Highlights',
    highlight: 'Highlight',
  },
  help: {
    markup: 'Leave empty to use the company markup.',
  },
  materials: {
    architectural: 'Architectural shingles',
    premium: 'Premium shingles',
    metal: 'Metal',
  },
  units: {
    per_square: 'Per square',
    per_edge_ft: 'Per edge foot',
    per_ridge_ft: 'Per ridge foot',
    per_valley_ft: 'Per valley foot',
    per_job: 'Per job',
  },
  addAddOn: 'Add add-on',
  removeAddOn: 'Remove add-on',
  addHighlight: 'Add highlight',
  removeHighlight: 'Remove highlight',
  /** Field messages, shown under the field that is wrong */
  errors: {
    name: 'Enter a name up to 60 characters.',
    material: 'Choose a material.',
    waste: 'Enter a waste from 0 to 50.',
    markup: 'Enter a markup from 0 to 100, or leave it empty.',
    addOnName: 'Enter a name up to 60 characters.',
    addOnUnit: 'Choose a unit.',
    addOnRate: 'Enter a rate from 0 to 10,000.',
    addOnsMax: 'Up to 8 add-ons.',
    highlight: 'Enter a highlight up to 60 characters.',
    highlightsMax: 'Up to 4 highlights.',
  },
} as const;
