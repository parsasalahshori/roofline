import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/app.ts';
import type { TenantContext } from '@roofline/db';
import { measureProperty } from '../src/estimator/measure.ts';

const db = vi.hoisted(() => ({
  getProperty: vi.fn(), updateProperty: vi.fn(), createMeasurement: vi.fn(), footprintsNear: vi.fn(), footprintStateStatus: vi.fn(), send: vi.fn(),
}));
vi.mock('@roofline/db', () => ({
  ...db,
  companySettings: { defaultPitchX12: 'pitch', overhangFt: 'overhang', companyId: 'company' },
  withTenant: async (_p: unknown, _c: unknown, run: (tx: unknown) => unknown) => run({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ pitchX12: 6, overhangFt: 1 }] }) }) }),
  }),
  US_MAP_CENTER: [-98, 39],
  createProperty: vi.fn(), listProperties: vi.fn(), setPropertyFootprint: vi.fn(),
  CustomerRequiredError: class extends Error {}, DuplicateAddressError: class extends Error {}, MeasurementPropertyNotFoundError: class extends Error {},
}));
vi.mock('@roofline/db/system', () => ({ footprintStateStatus: db.footprintStateStatus }));

const geocode = vi.fn();
const deps = {
  config: { DEMO_MODE: true, FAKE_PROVIDERS: true, DEMO_GEOCODER: 'census', NODE_ENV: 'test' },
  clock: { now: () => new Date('2026-10-14T00:00:00Z') }, pools: { system: {} }, geocoder: { geocode }, jobs: { send: db.send },
} as unknown as AppDeps;
const ctx = { companyId: 'company1' } as TenantContext;
beforeEach(() => {
  vi.clearAllMocks();
  db.getProperty.mockResolvedValue({ id: 'p1', addressLine: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', zip: '20500', geom: [-96, 41] });
  geocode.mockResolvedValue({ lng: -77.035, lat: 38.8987, source: 'census', accuracyType: 'range_interpolation' });
  db.createMeasurement.mockImplementation((_tx, _ctx, input) => ({ id: 'm1', ...input, drawMode: input.outline === null }));
});
describe('Census demo measurements require roof confirmation', () => {
  it('replaces a synthetic saved point with the lookup and never auto-picks a nearby footprint', async () => {
    const result = await measureProperty(deps, ctx, { propertyId: 'p1' });
    expect(geocode).toHaveBeenCalledWith('1600 Pennsylvania Ave NW, Washington, DC 20500');
    expect(result).toMatchObject({ center: [-77.035, 38.8987], outline: null, structures: [], drawMode: true });
    expect(db.updateProperty).toHaveBeenCalled();
    expect(db.footprintStateStatus).not.toHaveBeenCalled();
    expect(db.footprintsNear).not.toHaveBeenCalled();
    expect(db.send).not.toHaveBeenCalled();
  });
  it('refuses an unmatched saved address rather than displaying its fake coordinate', async () => {
    geocode.mockResolvedValue(null);
    await expect(measureProperty(deps, ctx, { propertyId: 'p1' })).rejects.toThrow('We could not find that address.');
    expect(db.createMeasurement).not.toHaveBeenCalled();
  });
});
