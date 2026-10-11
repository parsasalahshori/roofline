/*
 * The S1 tokens as literal values, keyed by custom property name without the `--`. Mirrors
 * tokens.css (test/tokens.test.ts fails if they drift). Use CSS variables in styles; use this
 * map where CSS variables cannot reach, such as the map's paint expressions.
 */
export const tokens = {
  bg: '#efe9dc',
  surface: '#fffdf8',
  'surface-2': '#f6f1e6',
  text: '#2b2620',
  'text-muted': 'rgba(43, 38, 32, 0.72)',
  accent: '#f5b324',
  'accent-ink': '#2b2620',
  success: '#2f9e44',
  danger: '#e03131',
  line: '#eee5cf',
  'radius-card': '12px',
  'radius-window': '14px',
  'shadow-window': '0 12px 30px rgba(60,40,0,.15)',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  'font-size-min': '12px',
  'font-size-body': '14px',
  'font-size-stat': '24px',
  'hail-1': '#ffe066',
  'hail-2': '#ffb347',
  'hail-3': '#ff7a45',
  'hail-4': '#f0508c',
  'hail-5': '#c026d3',
  'pin-customer': '#7048e8',
  'stage-lead': '#1971c2',
  'stage-inspection': '#0b7285',
  'stage-proposal': '#e67700',
  'stage-won': '#2f9e44',
} as const;

export type TokenName = keyof typeof tokens;
