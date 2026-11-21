// Synthetic roofs with small features the cleanup used to merge away (see roof-reconstruct-faces.test.ts).
import { synthesize } from './synthetic-roofs.ts';

export type Shape = Parameters<typeof synthesize>[0];
const EAVE = 3;

/**
 * A gable dormer on a roof: a 16 x 10 m gable at 6/12 (ridge along X) with a dormer 3.2 m wide at 8/12 on its south
 * face at X 0, its eaves 0.5 m above the main eave. Each dormer face is about 3 m2 (between tinyFaceM2 and
 * smallFaceM2) and narrow: the size of the dormers, bays and porch roofs EagleView draws and the cleanup merged away.
 */
const DORMER_HALF = 1.6;
export const DORMER_GABLE: Shape = {
  name: 'gable with a dormer',
  extent: 11,
  height: ({ x, y }) => {
    if (Math.abs(x) > 8 || Math.abs(y) > 5) return null;
    const main = EAVE + (5 - Math.abs(y)) * 0.5;
    const d = Math.abs(x);
    const dormer = y < 0 && d <= DORMER_HALF ? EAVE + 0.5 + (DORMER_HALF - d) * (8 / 12) : -Infinity;
    return Math.max(main, dormer);
  },
  faces: [
    { name: 'north', probe: { x: 0, y: 2.5 }, pitchX12: 6, downDeg: 90, planAreaM2: 80 },
    { name: 'south', probe: { x: 5, y: -2.5 }, pitchX12: 6, downDeg: -90, planAreaM2: 74 },
    { name: 'dormer east', probe: { x: 0.8, y: -4.2 }, pitchX12: 8, downDeg: 0, planAreaM2: 3 },
    { name: 'dormer west', probe: { x: -0.8, y: -4.2 }, pitchX12: 8, downDeg: 180, planAreaM2: 3 },
  ],
  lines: {},
  planAreaM2: 160,
};

/**
 * A steep gable dormer wide enough to be no thin face: a 16 x 10 m gable at 6/12 (ridge along X) with a dormer 5 m wide
 * at 10/12 on its south face at X 0, its eaves 0.3 m above the main eave, its front on the roof's edge. Each dormer
 * face is about 6.7 m2 and 1.05 m wide (2 area / perimeter): small, steeper than the roof by 4/12 and along the edge,
 * which is what the plane search's steep-face-by-the-edge rule dissolves when the heights are rough.
 */
const STEEP_HALF = 2.5;
export const STEEP_DORMER: Shape = {
  name: 'gable with a steep dormer',
  extent: 11,
  height: ({ x, y }) => {
    if (Math.abs(x) > 8 || Math.abs(y) > 5) return null;
    const main = EAVE + (5 - Math.abs(y)) * 0.5;
    const d = Math.abs(x);
    const dormer = y < 0 && d <= STEEP_HALF ? EAVE + 0.3 + (STEEP_HALF - d) * (10 / 12) : -Infinity;
    return Math.max(main, dormer);
  },
  faces: [
    { name: 'north', probe: { x: 0, y: 2.5 }, pitchX12: 6, downDeg: 90, planAreaM2: 80 },
    { name: 'south', probe: { x: 6, y: -2.5 }, pitchX12: 6, downDeg: -90, planAreaM2: 66.6 },
    { name: 'dormer east', probe: { x: 1.2, y: -3.6 }, pitchX12: 10, downDeg: 0, planAreaM2: 6.7 },
    { name: 'dormer west', probe: { x: -1.2, y: -3.6 }, pitchX12: 10, downDeg: 180, planAreaM2: 6.7 },
  ],
  lines: {},
  planAreaM2: 160,
};
