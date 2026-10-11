import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEagleView, ProviderClient } from '../server/providers.ts';

const report = { ReportId: 123, Street: '100 Test Lane', City: 'Austin', State: 'TX', Zip: '78701', Status: 'Completed', Area: '2,480 sq ft', Pitch: '6/12', LengthRidge: '50 ft', LengthHip: '20 ft', LengthEave: '120 ft', LengthRake: '60 ft', LengthValley: '24 ft', TotalRoofFacets: '6' };
test('normalizes documented EagleView v3 fields and combines edge / cap lengths', () => {
  const m = normalizeEagleView(report);
  assert.equal(m.areaSqFt, 2480); assert.equal(m.pitch, 6); assert.equal(m.edgeFt, 180); assert.equal(m.ridgeFt, 70);
  assert.equal(m.areaType, 'surface'); assert.equal(m.reference, 'EagleView #123');
});
test('incomplete or ambiguous measurements cannot produce invented geometry', () => {
  assert.throws(() => normalizeEagleView({ ...report, Area: 'pending' }));
  assert.throws(() => normalizeEagleView({ ...report, Pitch: 'unknown' }));
  assert.throws(() => normalizeEagleView({ ...report, Area: '230 m2' }));
});
test('missing keys fail before network requests', async () => {
  const client = new ProviderClient({}, async () => { throw Error('network should not run'); });
  await assert.rejects(client.geocode('100 Main Street'), /GOOGLE_MAPS_API_KEY/);
  await assert.rejects(client.eagleview('123'), /EAGLEVIEW_ACCESS_TOKEN/);
});
test('upstream quota response gives a safe actionable error without secrets', async () => {
  const client = new ProviderClient({ GOOGLE_MAPS_API_KEY: 'secret-key' }, async () => new Response(JSON.stringify({status:'OVER_QUERY_LIMIT'}), {status:200}));
  await assert.rejects(client.geocode('100 Main Street'), /quota/i);
});
test('geocoding returns candidates and never roof area', async () => {
  const client = new ProviderClient({ GOOGLE_MAPS_API_KEY: 'test' }, async () => new Response(JSON.stringify({status:'OK',results:[{formatted_address:'100 Main St',place_id:'abc',partial_match:true,geometry:{location:{lat:30,lng:-97},location_type:'APPROXIMATE'}}]})));
  const candidates = await client.geocode('Main Street');
  assert.equal(candidates[0].needsConfirmation, true); assert.equal('areaSqFt' in candidates[0], false);
});
