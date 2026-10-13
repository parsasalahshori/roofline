import { beforeEach, describe, expect, it } from 'vitest';
import { claimFootprintState, finishFootprintState, insertFootprints } from '@roofline/db/system';
import type { MeasurementView, Ring } from '@roofline/shared';
import { Actors, dbProperty } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DemoGeocoder } from '../src/providers/fakes/geocoder.ts';

/*
 * DEMO_MODE: a typed address (a real-looking one too) lands on one of the seeded empty demo houses, picked by a
 * hash of the text, so Measure always shows an outline. Outside DEMO_MODE the normal lookup runs (measurements.test).
 */

let t: TestApp;
let who: Actors;

/** A 14 m by 10 m house centred on a point near Omaha, as the demo seed writes them. */
function house(lng: number, lat: number): Ring {
  const [w, d] = [7 / 83_700, 5 / 111_320];
  return [
    [lng - w, lat - d],
    [lng + w, lat - d],
    [lng + w, lat + d],
    [lng - w, lat + d],
    [lng - w, lat - d],
  ];
}

async function loadDemoHouses(): Promise<void> {
  const now = t.clock.now();
  expect(await claimFootprintState(t.deps.pools.system, 'NE', 'https://fixtures.test/NE.zip', now)).toBe(true);
  const rings = [0, 1, 2, 3, 4].map((i) => ({ sourceRef: `demo-next-${i}-0`, ring: house(-96.05 + i * 0.001, 41.26) }));
  const count = await insertFootprints(t.deps.pools.system, 'NE', [{ sourceRef: 'demo-home-0', ring: house(-96.06, 41.26) }, ...rings]);
  await finishFootprintState(t.deps.pools.system, 'NE', count, now);
}

async function measureAddress(address: string): Promise<MeasurementView> {
  const owner = await who.as('owner');
  const res = await owner.post('/api/measurements').send({ address });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as MeasurementView;
}

beforeEach(async () => {
  t = await makeTestApp({ DEMO_MODE: true });
  (t.deps as unknown as { geocoder: DemoGeocoder }).geocoder = new DemoGeocoder();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-13T15:00:00.000Z'));
});

describe('DEMO_MODE typed address', () => {
  it('any address lands on an empty demo house with its outline, its fictional Omaha address and no customer', async () => {
    await loadDemoHouses();
    const m = await measureAddress('1600 Pennsylvania Ave NW, Washington, DC 20500');
    expect(m.drawMode).toBe(false);
    expect(m.outline?.[0]?.length).toBeGreaterThanOrEqual(4);
    expect(m.estimate.squares).toBeGreaterThan(0);
    expect(m.hasCustomer).toBe(false);
    expect(m.structures.filter((s) => s.included)).toHaveLength(1);
    const home = await dbProperty(t, t.seed.a.companyId, m.propertyId);
    expect(home).toMatchObject({ city: 'Omaha', state: 'NE' });
    expect(home?.addressLine).not.toMatch(/Pennsylvania/);
  });

  it('the same address picks the same house; the home on it is reused', async () => {
    await loadDemoHouses();
    const first = await measureAddress('512 Maple Ave, Omaha, NE 68102');
    const again = await measureAddress('  512 maple ave,   OMAHA, ne 68102 ');
    expect(again.propertyId).toBe(first.propertyId);
    expect(again.id).not.toBe(first.id);
  });

  it('with no demo houses loaded the normal lookup runs', async () => {
    const m = await measureAddress('512 Maple Ave, Omaha, NE 68102');
    const home = await dbProperty(t, t.seed.a.companyId, m.propertyId);
    expect(home).toMatchObject({ addressLine: '512 Maple Ave', zip: '68102' });
  });
});
