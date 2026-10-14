import { describe, expect, it } from 'vitest';
import { footprintTilesInBox, footprintTilesNear, isFootprintQuadkey, quadkeyOf } from '../src/quadkey.ts';

describe('quadkeyOf', () => {
  it('matches the Bing tile system for known points', () => {
    // 3000 Connecticut Ave NW, Washington DC, and Omaha NE (tiles listed in Microsoft's dataset index).
    expect(quadkeyOf(-77.0498, 38.9296)).toBe('032010032');
    expect(quadkeyOf(-95.93456, 41.256455)).toBe('021332333');
    expect(quadkeyOf(0.0001, -0.0001, 1)).toBe('3');
    expect(quadkeyOf(-0.0001, 0.0001, 1)).toBe('0');
  });
  it('clamps points off the map', () => {
    expect(quadkeyOf(-200, 89)).toBe('000000000');
    expect(quadkeyOf(200, -89)).toBe('333333333');
  });
});

describe('isFootprintQuadkey', () => {
  it('accepts nine digits 0-3 only', () => {
    expect(isFootprintQuadkey('032010032')).toBe(true);
    for (const v of ['03201003', '0320100321', '032010034', 'NE', '']) expect(isFootprintQuadkey(v)).toBe(false);
  });
});

describe('footprintTilesNear', () => {
  it('is just the own tile away from any edge', () => {
    expect(footprintTilesNear(-77.0498, 38.9296)).toEqual(['032010032']);
  });
  it('adds the tile next door near an edge, and the three others near a corner', () => {
    // Zoom-9 tiles are 360/512 degrees wide: -77.34375 is a tile edge.
    const edge = -77.34375;
    const west = footprintTilesNear(edge + 0.0005, 38.9296);
    expect(west).toHaveLength(2);
    expect(west[0]).toBe(quadkeyOf(edge + 0.0005, 38.9296));
    expect(west[1]).toBe(quadkeyOf(edge - 0.0005, 38.9296));
    expect(footprintTilesNear(edge + 0.01, 38.9296)).toHaveLength(1);
    // The equator and the prime meridian meet at a corner of four tiles.
    expect(new Set(footprintTilesNear(0.0001, 0.0001)).size).toBe(4);
  });
});

describe('footprintTilesInBox', () => {
  it('lists the zoom-9 tiles a building-level view covers: one inside a tile, more across an edge', () => {
    // A few hundred metres around a point in Omaha: one tile, the point's own.
    expect(footprintTilesInBox(-96.005, 41.247, -95.995, 41.253)).toEqual([quadkeyOf(-96, 41.25)]);
    // Across a tile edge (zoom-9 tiles are 0.703125 degrees wide; -95.625 is an edge): two tiles, left to right.
    const across = footprintTilesInBox(-95.63, 41.25, -95.62, 41.26)!;
    expect(across).toEqual([quadkeyOf(-95.63, 41.255), quadkeyOf(-95.62, 41.255)]);
  });

  it('is null for a view zoomed out past building level, or a box that is not one', () => {
    expect(footprintTilesInBox(-100, 38, -90, 44)).toBeNull();
    expect(footprintTilesInBox(-95, 41, -96, 42)).toBeNull();
    expect(footprintTilesInBox(Number.NaN, 41, -96, 42)).toBeNull();
  });
});
