import { describe, expect, it } from 'vitest';
import { evaluatePhoto } from '../window-photo-bench/evaluate.ts';
import { table } from '../window-photo-bench/report.ts';
import { benchWindows } from '../window-photo-bench/scenes.ts';

// A few benchmark photos at 3 MP (the full run is `npx tsx scripts/window-photo-bench/bench.ts`).
describe('window photo benchmark (small)', () => {
  it('is reproducible and the sheet + snapping + offset method beats the old paper clicks', () => {
    const wins = benchWindows(2, 7);
    expect(benchWindows(2, 7)).toEqual(wins);
    const errs: { paper: number; sheet: number }[] = [];
    for (const w of wins) {
      const p = { ...w.photos[0]!, megapixels: 3 as const, scene: { ...w.photos[0]!.scene, widthPx: 1512, heightPx: 2016, supersample: 2 } };
      const r = evaluatePhoto(w.id, 0, p, { w: w.widthIn, h: w.heightIn, offsetIn: w.offsetIn });
      expect(r.detected).toBe(true);
      // The engine's own proposal around the sheet offers the right outline among the top 3.
      expect(r.rankP).toBeGreaterThanOrEqual(1);
      expect(r.rankP).toBeLessThanOrEqual(3);
      const s = r.results.sheetSnapOffset!;
      const old = r.results.paper4!;
      errs.push({ paper: Math.max(Math.abs(old.w - w.widthIn), Math.abs(old.h - w.heightIn)), sheet: Math.max(Math.abs(s.w - w.widthIn), Math.abs(s.h - w.heightIn)) });
    }
    for (const e of errs) expect(e.sheet).toBeLessThan(0.3);
    expect(errs.reduce((a, e) => a + e.sheet, 0)).toBeLessThan(errs.reduce((a, e) => a + e.paper, 0));
    expect(table('t', [{ method: 'm', errW: [0.1, -0.2], errH: [0.05], refused: 1, total: 3 }])).toContain('| m | 2 | 1/3 | 0.150 |');
  }, 120_000);
});
