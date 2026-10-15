import { describe, expect, it } from 'vitest';
import { cropLas, gpsDate, LasError, lasCrs, parseLasHeader, utmZoneOf } from '../../src/providers/usgs-lidar-las.ts';
import { E0, fixtureBytes, N0 } from './usgs-lidar-fixture.ts';

/* Reading 3DEP LAS/LAZ: header, CRS, the crop round a house, and every bound. Fixtures: make_fixture.py. */

const LIMITS = { maxBytes: 10 << 20, maxPointsScanned: 1_000_000, maxPointsKept: 1_000_000 };
const ROOF_BOX = { x0: E0 + 44, x1: E0 + 56, y0: N0 + 40, y1: N0 + 60 };
const WIDE_BOX = { x0: E0 + 10, x1: E0 + 90, y0: N0 + 10, y1: N0 + 90 };

describe('LAS header and CRS', () => {
  it('reads a LAS 1.4 format 6 LAZ header with its WKT, and finds UTM zone 15 in metres', () => {
    const h = parseLasHeader(fixtureBytes('house-14-fmt6.laz'));
    expect(h).toMatchObject({ versionMinor: 4, pointFormat: 6, pointCount: 40000, compressed: true });
    expect(h.wkt).toContain('UTM zone 15N');
    expect(lasCrs(h)).toEqual({ epsg: 26915, zone: 15, zUnitM: 1 });
  });

  it('reads a LAS 1.2 format 1 header through its GeoKeys', () => {
    const h = parseLasHeader(fixtureBytes('house-12-fmt1.laz'));
    expect(h).toMatchObject({ versionMinor: 2, pointFormat: 1, pointCount: 40000, compressed: true });
    expect(lasCrs(h).zone).toBe(15);
  });

  it('refuses what is not LAS, and a CRS that is not UTM in metres', () => {
    expect(() => parseLasHeader(new TextEncoder().encode('<html>not found</html>'.padEnd(400)))).toThrow(LasError);
    const h = parseLasHeader(fixtureBytes('house-14-fmt6.laz'));
    const statePlane = { ...h, wkt: 'PROJCS["NAD83(2011) / Arkansas North (ftUS)",UNIT["US survey foot",0.3048006096]]', geoKeyEpsg: null };
    expect(() => lasCrs(statePlane)).toThrow(expect.objectContaining({ reason: 'not-utm' }));
    expect(() => lasCrs({ ...h, wkt: null, geoKeyEpsg: null })).toThrow(expect.objectContaining({ reason: 'no-crs' }));
    expect([utmZoneOf(6344), utmZoneOf(26915), utmZoneOf(32615), utmZoneOf(2227)]).toEqual([15, 15, 15, null]);
  });
});

describe('cropLas', () => {
  it('keeps the roof points inside the box, drops noise, flags last returns and ground', async () => {
    const c = await cropLas(fixtureBytes('house-14-fmt6.laz'), ROOF_BOX, LIMITS);
    expect(c.x.length).toBeGreaterThan(900);
    expect(c.x.length).toBeLessThan(1100);
    for (let i = 0; i < c.x.length; i++) {
      expect(c.x[i]).toBeGreaterThanOrEqual(ROOF_BOX.x0 - 0.01);
      expect(c.x[i]).toBeLessThanOrEqual(ROOF_BOX.x1 + 0.01);
    }
    expect([...c.cls].every((k) => k === 6 || k === 2)).toBe(true);
    expect([...c.flags].every((f) => (f & 1) === 1)).toBe(true);
    const roof = [...c.cls].map((k, i) => (k === 6 ? c.z[i]! : null)).filter((z): z is number => z !== null);
    expect(Math.abs(roof.reduce((a, b) => a + b, 0) / roof.length - 106)).toBeLessThan(0.05);
    expect(c.gpsTime).not.toBeNull();
    expect(gpsDate(c.gpsTime![0])).toBe('2025-02-10');
  });

  it('a format 1 LAS 1.2 tile gives the same points as the format 6 LAS 1.4 one', async () => {
    const a = await cropLas(fixtureBytes('house-14-fmt6.laz'), WIDE_BOX, LIMITS);
    const b = await cropLas(fixtureBytes('house-12-fmt1.laz'), WIDE_BOX, LIMITS);
    expect(b.x).toEqual(a.x);
    expect(b.z).toEqual(a.z);
    expect(b.cls).toEqual(a.cls);
  });

  it('reads an uncompressed LAS the same way', async () => {
    const all = { x0: E0 - 1, x1: E0 + 101, y0: N0 - 1, y1: N0 + 101 };
    const c = await cropLas(fixtureBytes('house-14-fmt6-head.las'), all, LIMITS);
    expect(c.scanned).toBe(2000);
    expect(c.x.length).toBe(2000 - 3); // points 0, 997 and 1994 are noise
  });

  it('is deterministic: the same bytes give identical arrays', async () => {
    const a = await cropLas(fixtureBytes('house-14-fmt6.laz'), WIDE_BOX, LIMITS);
    const b = await cropLas(fixtureBytes('house-14-fmt6.laz'), WIDE_BOX, LIMITS);
    expect(Buffer.from(b.z.buffer)).toEqual(Buffer.from(a.z.buffer));
    expect(Buffer.from(b.x.buffer)).toEqual(Buffer.from(a.x.buffer));
  });

  it('every bound is a typed too-large, never a crash', async () => {
    const bytes = fixtureBytes('house-14-fmt6.laz');
    await expect(cropLas(bytes, WIDE_BOX, { ...LIMITS, maxBytes: 1000 })).rejects.toMatchObject({ reason: 'too-large' });
    await expect(cropLas(bytes, WIDE_BOX, { ...LIMITS, maxPointsScanned: 100 })).rejects.toMatchObject({ reason: 'too-large' });
    await expect(cropLas(bytes, WIDE_BOX, { ...LIMITS, maxPointsKept: 100 })).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('a truncated LAZ is a typed decode failure', async () => {
    const bytes = fixtureBytes('house-14-fmt6.laz');
    await expect(cropLas(bytes.subarray(0, 20_000), WIDE_BOX, LIMITS)).rejects.toBeInstanceOf(LasError);
  });
});
