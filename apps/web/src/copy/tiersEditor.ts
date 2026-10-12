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
  fields: {
    enabled: 'Offer this option',
    highlights: 'Highlights',
    highlight: 'Highlight',
  },
  help: {
    markup: 'Leave empty to use the company markup.',
  },
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
