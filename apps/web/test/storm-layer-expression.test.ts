import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { HAIL_LEVEL_COLORS, hailFillExpression } from '../src/shell/map/stormLayer.ts';

/** The fill-color property spec MapLibre checks a data-driven colour expression against. */
const FILL_COLOR = {
  type: 'color',
  'property-type': 'data-driven',
  expression: { interpolated: false, parameters: ['zoom', 'feature'] },
} as const;

describe('hailFillExpression', () => {
  const compiled = createExpression(hailFillExpression(), FILL_COLOR as never);

  it('is an expression MapLibre accepts (a decimal-label match is refused, so no swath was drawn)', () => {
    expect(compiled.result).toBe('success');
  });

  it.each([
    [0.75, 0],
    [1, 0],
    [1.25, 1],
    [1.5, 1],
    [1.75, 2],
    [2, 2],
    [2.5, 3],
    [3, 4],
    [4, 4],
  ])('a %s inch contour gets hail level %i + 1', (thresholdIn, level) => {
    if (compiled.result !== 'success') throw new Error('expression refused');
    const colour = compiled.value.evaluate({ zoom: 10 }, { type: 'Polygon', properties: { thresholdIn } } as never);
    const expected = createExpression(HAIL_LEVEL_COLORS[level]!, FILL_COLOR as never);
    if (expected.result !== 'success') throw new Error('colour refused');
    expect(String(colour)).toBe(String(expected.value.evaluate({ zoom: 10 })));
  });
});
