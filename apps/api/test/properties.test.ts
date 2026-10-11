import { beforeEach, describe, expect, test } from 'vitest';
import {
  companies,
  createProperty,
  CustomerRequiredError,
  findPgError,
  jobs,
  properties,
  type TenantContext,
  updateProperty,
  withTenant,
} from '@roofline/db';
import { Actors, addressFor, dbAudit, dbProperty, inCompany, mustCreate, NO_UUID, NOT_FOUND, timeline } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const CHECK_FIELD = 'Please check this field.';
const NOTHING = "There's nothing to change.";
const STREET = 'Please enter the street address.';
const CITY = 'Please enter the city.';
const STATE = 'Please use the 2-letter state code.';
const ZIP = 'Please enter a 5-digit ZIP code.';
const LATLNG = 'Please give both latitude and longitude.';
const ZONE = 'Please pick a valid time zone.';
const YEAR = 'Please enter a year from 1800 to 2026.';
const NO_CUSTOMER = "We couldn't find that customer.";
const SAVED = 'This address is already saved.';
const TOO_LONG = 'That is too long.';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

const A = () => t.seed.a.companyId;
const full = { addressLine: '12 Oak St', city: 'Omaha', state: 'NE', zip: '68102' };

describe('adding an address', () => {
  test('the answer has the documented shape; the company time zone is the default', async () => {
    const res = await (await who.as('office')).post('/api/properties').send(full);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      customerId: null,
      addressLine: '12 Oak St',
      city: 'Omaha',
      state: 'NE',
      zip: '68102',
      lat: null,
      lng: null,
      timezone: 'America/Chicago',
      yearBuilt: null,
      archivedAt: null,
      createdAt: '2026-10-12T15:00:00.000Z',
      updatedAt: '2026-10-12T15:00:00.000Z',
    });
  });

  test("the default time zone is the company's own, whatever it is", async () => {
    await inCompany(t, A(), (tx) => tx.update(companies).set({ timezone: 'America/Denver' }));
    const res = await (await who.as('owner')).post('/api/properties').send(full);
    expect(res.body.timezone).toBe('America/Denver');
    expect((await dbProperty(t, A(), res.body.id)).timezone).toBe('America/Denver');
  });

  test('every field can be given: customer, location, time zone, year built', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly' });
    const res = await owner.post('/api/properties').send({
      ...full,
      customerId: customer.id,
      lat: 41.2565,
      lng: -95.9345,
      timezone: 'America/New_York',
      yearBuilt: 1987,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      customerId: customer.id,
      lat: 41.2565,
      lng: -95.9345,
      timezone: 'America/New_York',
      yearBuilt: 1987,
    });
    // geom is [longitude, latitude].
    expect((await dbProperty(t, A(), res.body.id)).geom).toEqual([-95.9345, 41.2565]);
  });

  test.each(['America/Indiana/Indianapolis', 'America/Kentucky/Louisville', 'US/Central'])(
    'a real US zone the IANA list spells differently is accepted: %s',
    async (timezone) => {
      const res = await (await who.as('owner')).post('/api/properties').send({ ...full, state: 'IN', timezone });
      expect(res.status).toBe(201);
      expect(res.body.timezone).toBe(timezone);
      expect((await dbProperty(t, A(), res.body.id)).timezone).toBe(timezone);
    },
  );

  test('text is trimmed and the state is upper-cased', async () => {
    const res = await (await who.as('owner'))
      .post('/api/properties')
      .send({ addressLine: '  12 Oak St ', city: ' Omaha ', state: ' ne ', zip: ' 68102 ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ addressLine: '12 Oak St', city: 'Omaha', state: 'NE', zip: '68102' });
  });

  test('writes the audit row, a timeline line and the normalized address key, all from the app clock', async () => {
    t.clock.set(new Date('2026-11-01T08:15:00.000Z'));
    const res = await (await who.as('office')).post('/api/properties').send({ ...full, addressLine: '12  Oak St.' });
    expect(await timeline(t, A(), res.body.id)).toEqual([['property.created', 'Address added']]);
    const [row] = await dbAudit(t, A(), 'property.create');
    expect(row).toMatchObject({ targetType: 'property', targetId: res.body.id, actorUserId: who.user('office').userId, before: null });
    expect(row!.after).toMatchObject({ addressLine: '12  Oak St.', zip: '68102' });
    expect(row!.at).toEqual(new Date('2026-11-01T08:15:00.000Z'));
    const stored = await dbProperty(t, A(), res.body.id);
    expect(stored.addressKey).toBe('12 oak st|68102');
    expect(stored.createdAt).toEqual(new Date('2026-11-01T08:15:00.000Z'));
  });

  test('the same address written another way is a 409, and nothing else is saved', async () => {
    const owner = await who.as('owner');
    await mustCreate(owner, '/api/properties', full);
    for (const addressLine of ['12 Oak St', '12 oak st.', '  12   OAK   ST ', '12 Oak St,']) {
      const res = await owner.post('/api/properties').send({ ...full, addressLine, city: 'Elsewhere' });
      expect(res.status, addressLine).toBe(409);
      expect(res.body, addressLine).toEqual({ error: SAVED, field: 'addressLine' });
    }
    expect((await owner.get('/api/properties')).body.total).toBe(1);
    expect(await dbAudit(t, A(), 'property.create')).toHaveLength(1);
  });

  test('two requests for one address at the same moment: one is saved, the other is a 409 (never a 500)', async () => {
    const owner = await who.as('owner');
    const office = await who.as('office');
    const results = await Promise.all([
      owner.post('/api/properties').send(full),
      office.post('/api/properties').send({ ...full, addressLine: '12 OAK ST.' }),
      owner.post('/api/properties').send({ ...full, addressLine: ' 12 oak  st' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter((r) => r.status === 409).map((r) => r.body)).toEqual(Array(2).fill({ error: SAVED, field: 'addressLine' }));
    expect(await inCompany(t, A(), (tx) => tx.select().from(properties))).toHaveLength(1);
    expect(await dbAudit(t, A(), 'property.create')).toHaveLength(1);
  });

  test('a different ZIP or another street is a different address', async () => {
    const owner = await who.as('owner');
    await mustCreate(owner, '/api/properties', full);
    expect((await owner.post('/api/properties').send({ ...full, zip: '68103' })).status).toBe(201);
    expect((await owner.post('/api/properties').send({ ...full, addressLine: '14 Oak St' })).status).toBe(201);
  });

  test('an address a rep cannot see still counts as saved', async () => {
    await mustCreate(await who.as('owner'), '/api/properties', full);
    const rep = await who.as('rep');
    const mine = await mustCreate(rep, '/api/customers', { displayName: 'Rep customer' });
    const res = await rep.post('/api/properties').send({ ...full, customerId: mine.id });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: SAVED, field: 'addressLine' });
  });

  test('an archived address is still saved: it must be restored, not added again', async () => {
    const owner = await who.as('owner');
    const made = await mustCreate(owner, '/api/properties', full);
    await owner.post(`/api/properties/${made.id}/archive`);
    expect((await owner.post('/api/properties').send(full)).status).toBe(409);
  });

  test.each<[string, Record<string, unknown>, string, string]>([
    ['no street address', { addressLine: undefined }, 'addressLine', STREET],
    ['a blank street address', { addressLine: '   ' }, 'addressLine', STREET],
    ['a street address that is only punctuation', { addressLine: '#.,' }, 'addressLine', STREET],
    ['a street address that is not text', { addressLine: 12 }, 'addressLine', STREET],
    ['a street address that is too long', { addressLine: 'x'.repeat(201) }, 'addressLine', TOO_LONG],
    ['no city', { city: undefined }, 'city', CITY],
    ['a blank city', { city: ' ' }, 'city', CITY],
    ['a city that is too long', { city: 'x'.repeat(101) }, 'city', TOO_LONG],
    ['no state', { state: undefined }, 'state', STATE],
    ['a state spelled out', { state: 'Nebraska' }, 'state', STATE],
    ['a one-letter state', { state: 'N' }, 'state', STATE],
    ['a state with a digit', { state: 'N1' }, 'state', STATE],
    ['no ZIP', { zip: undefined }, 'zip', ZIP],
    ['a four-digit ZIP', { zip: '6810' }, 'zip', ZIP],
    ['a ZIP+4', { zip: '68102-1234' }, 'zip', ZIP],
    ['a ZIP written as a number', { zip: 68102 }, 'zip', ZIP],
    ['a latitude with no longitude', { lat: 41.2 }, 'lng', LATLNG],
    ['a longitude with no latitude', { lng: -95.9 }, 'lat', LATLNG],
    ['a latitude past the pole', { lat: 91, lng: 0 }, 'lat', LATLNG],
    ['a longitude past the date line', { lat: 0, lng: 180.5 }, 'lng', LATLNG],
    ['a latitude in text', { lat: '41.2', lng: -95.9 }, 'lat', LATLNG],
    ['a made-up time zone', { timezone: 'Mars/Olympus' }, 'timezone', ZONE],
    ['a time zone that is not text', { timezone: 5 }, 'timezone', ZONE],
    ['a fixed offset for a time zone', { timezone: '-06:00' }, 'timezone', ZONE],
    ['a year before 1800', { yearBuilt: 1799 }, 'yearBuilt', YEAR],
    ['a year in the future', { yearBuilt: 2027 }, 'yearBuilt', YEAR],
    ['a year with a fraction', { yearBuilt: 1999.5 }, 'yearBuilt', YEAR],
    ['a year in text', { yearBuilt: '1999' }, 'yearBuilt', YEAR],
    ['a customer that is not an id', { customerId: 'molly' }, 'customerId', NO_CUSTOMER],
    ['a customer that does not exist', { customerId: NO_UUID }, 'customerId', NO_CUSTOMER],
    ['a field nobody knows', { colour: 'red' }, 'colour', CHECK_FIELD],
    ['a field only the system sets', { geocodeSource: 'google' }, 'geocodeSource', CHECK_FIELD],
    ['the address key', { addressKey: 'x' }, 'addressKey', CHECK_FIELD],
  ])('%s → 400', async (_name, change, field, message) => {
    const res = await (await who.as('owner')).post('/api/properties').send({ ...full, ...change });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message, field });
    expect(await inCompany(t, A(), (tx) => tx.select().from(properties))).toEqual([]);
  });

  test('the edges are fine: the poles, the date line, 1800 and this year', async () => {
    const owner = await who.as('owner');
    for (const [n, body] of [
      [1, { lat: 90, lng: 180 }],
      [2, { lat: -90, lng: -180 }],
      [3, { yearBuilt: 1800 }],
      [4, { yearBuilt: 2026 }],
      [5, { lat: 0, lng: 0 }],
    ] as const) {
      const res = await owner.post('/api/properties').send({ ...addressFor(n), ...body });
      expect(res.status, JSON.stringify(body)).toBe(201);
    }
  });

  test('the highest year allowed follows the app clock', async () => {
    t.clock.set(new Date('2028-03-01T12:00:00.000Z'));
    const owner = await who.as('owner');
    expect((await owner.post('/api/properties').send({ ...full, yearBuilt: 2028 })).status).toBe(201);
    const res = await owner.post('/api/properties').send({ ...addressFor(2), yearBuilt: 2029 });
    expect(res.body).toEqual({ error: 'Please enter a year from 1800 to 2028.', field: 'yearBuilt' });
  });

  test('null for the optional fields means "none"', async () => {
    const res = await (await who.as('owner')).post('/api/properties').send({ ...full, customerId: null, yearBuilt: null, lat: null, lng: null });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ customerId: null, yearBuilt: null, lat: null, lng: null });
  });

  test('an empty body names the first thing that is missing', async () => {
    const res = await (await who.as('owner')).post('/api/properties').send({});
    expect(res.body).toEqual({ error: STREET, field: 'addressLine' });
  });
});

describe('changing an address', () => {
  async function made(extra: Record<string, unknown> = {}) {
    return mustCreate(await who.as('owner'), '/api/properties', { ...full, ...extra });
  }

  test('changes only the fields named, bumps updatedAt from the clock, and says what changed in audit and timeline', async () => {
    const p = await made({ yearBuilt: 1990 });
    t.clock.set(new Date('2026-10-14T09:30:00.000Z'));
    const res = await (await who.as('office')).patch(`/api/properties/${p.id}`).send({ city: 'Lincoln', yearBuilt: 2001 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      addressLine: '12 Oak St',
      city: 'Lincoln',
      yearBuilt: 2001,
      createdAt: '2026-10-12T15:00:00.000Z',
      updatedAt: '2026-10-14T09:30:00.000Z',
    });
    const [row] = await dbAudit(t, A(), 'property.update');
    expect(row).toMatchObject({ targetType: 'property', targetId: p.id, actorUserId: who.user('office').userId });
    expect(row!.before).toEqual({ city: 'Omaha', yearBuilt: 1990 });
    expect(row!.after).toEqual({ city: 'Lincoln', yearBuilt: 2001 });
    expect(row!.at).toEqual(new Date('2026-10-14T09:30:00.000Z'));
    expect(await timeline(t, A(), p.id as string)).toEqual([
      ['property.created', 'Address added'],
      ['property.updated', 'Address details updated'],
    ]);
  });

  test('a PATCH that changes nothing still leaves an audit row', async () => {
    const p = await made();
    await (await who.as('owner')).patch(`/api/properties/${p.id}`).send({ city: 'Omaha' });
    const [row] = await dbAudit(t, A(), 'property.update');
    expect(row!.before).toEqual({ city: 'Omaha' });
    expect(row!.after).toEqual({ city: 'Omaha' });
  });

  test('moving the street address or the ZIP updates the key; another address with that key is a 409', async () => {
    const owner = await who.as('owner');
    const p = await made();
    const other = await mustCreate(owner, '/api/properties', { ...full, addressLine: '14 Oak St' });
    const clash = await owner.patch(`/api/properties/${other.id}`).send({ addressLine: '12 oak st.' });
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({ error: SAVED, field: 'addressLine' });
    expect((await dbProperty(t, A(), other.id)).addressLine).toBe('14 Oak St');

    const zipClash = await owner.patch(`/api/properties/${other.id}`).send({ addressLine: '12 Oak St', zip: '68103' });
    expect(zipClash.status).toBe(200);
    expect((await dbProperty(t, A(), other.id)).addressKey).toBe('12 oak st|68103');
    expect((await dbProperty(t, A(), p.id as string)).addressKey).toBe('12 oak st|68102');
    // Only the ZIP changes: the key follows the stored street.
    const back = await owner.patch(`/api/properties/${other.id}`).send({ zip: '68102' });
    expect(back.status).toBe(409);
  });

  test('re-saving the same address (a different spelling of itself) is not a clash', async () => {
    const p = await made();
    const res = await (await who.as('owner')).patch(`/api/properties/${p.id}`).send({ addressLine: '12 OAK ST.' });
    expect(res.status).toBe(200);
    expect(res.body.addressLine).toBe('12 OAK ST.');
    expect((await dbProperty(t, A(), p.id as string)).addressKey).toBe('12 oak st|68102');
  });

  test('the location is set from lat and lng together, and cleared with both null', async () => {
    const p = await made();
    const owner = await who.as('owner');
    const set = await owner.patch(`/api/properties/${p.id}`).send({ lat: 40.8, lng: -96.7 });
    expect(set.body).toMatchObject({ lat: 40.8, lng: -96.7 });
    expect((await dbProperty(t, A(), p.id as string)).geom).toEqual([-96.7, 40.8]);
    const [row] = await dbAudit(t, A(), 'property.update');
    expect(row!.before).toEqual({ lat: null, lng: null });
    expect(row!.after).toEqual({ lat: 40.8, lng: -96.7 });

    const half = await owner.patch(`/api/properties/${p.id}`).send({ lat: 41 });
    expect(half.body).toEqual({ error: LATLNG, field: 'lng' });
    const mixed = await owner.patch(`/api/properties/${p.id}`).send({ lat: null, lng: -96 });
    expect(mixed.body).toEqual({ error: LATLNG, field: 'lat' });
    expect((await dbProperty(t, A(), p.id as string)).geom).toEqual([-96.7, 40.8]);

    const cleared = await owner.patch(`/api/properties/${p.id}`).send({ lat: null, lng: null });
    expect(cleared.body).toMatchObject({ lat: null, lng: null });
    expect((await dbProperty(t, A(), p.id as string)).geom).toBeNull();
  });

  test('the customer can be set, changed and cleared', async () => {
    const owner = await who.as('owner');
    const p = await made();
    const molly = await mustCreate(owner, '/api/customers', { displayName: 'Molly' });
    expect((await owner.patch(`/api/properties/${p.id}`).send({ customerId: molly.id })).body.customerId).toBe(molly.id);
    expect((await owner.patch(`/api/properties/${p.id}`).send({ customerId: null })).body.customerId).toBeNull();
    const gone = await owner.patch(`/api/properties/${p.id}`).send({ customerId: NO_UUID });
    expect(gone.status).toBe(400);
    expect(gone.body).toEqual({ error: NO_CUSTOMER, field: 'customerId' });
  });

  test('year built and the time zone can be changed; year built can be cleared', async () => {
    const p = await made({ yearBuilt: 1990 });
    const owner = await who.as('owner');
    const res = await owner.patch(`/api/properties/${p.id}`).send({ timezone: 'America/Denver', yearBuilt: null });
    expect(res.body).toMatchObject({ timezone: 'America/Denver', yearBuilt: null });
    expect((await owner.patch(`/api/properties/${p.id}`).send({ timezone: null })).body).toEqual({ error: ZONE, field: 'timezone' });
  });

  test.each<[string, Record<string, unknown>, string, string]>([
    ['a blank street address', { addressLine: ' ' }, 'addressLine', STREET],
    ['a blank city', { city: '' }, 'city', CITY],
    ['a bad state', { state: 'Neb' }, 'state', STATE],
    ['a bad ZIP', { zip: '1234' }, 'zip', ZIP],
    ['a bad year', { yearBuilt: 3000 }, 'yearBuilt', YEAR],
    ['a null street address', { addressLine: null }, 'addressLine', STREET],
    ['an unknown field', { colour: 'red' }, 'colour', CHECK_FIELD],
    ['the key itself', { addressKey: 'x' }, 'addressKey', CHECK_FIELD],
    ['the id', { id: NO_UUID }, 'id', CHECK_FIELD],
    ['the archived time', { archivedAt: null }, 'archivedAt', CHECK_FIELD],
  ])('%s → 400, nothing changes', async (_name, change, field, message) => {
    const p = await made();
    const res = await (await who.as('owner')).patch(`/api/properties/${p.id}`).send(change);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message, field });
    expect(await dbAudit(t, A(), 'property.update')).toEqual([]);
  });

  test('an empty body is "nothing to change"', async () => {
    const p = await made();
    const res = await (await who.as('owner')).patch(`/api/properties/${p.id}`).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NOTHING });
  });

  test('an address that does not exist, or an id that is not one, is a 404', async () => {
    const owner = await who.as('owner');
    for (const id of [NO_UUID, 'not-an-id']) {
      for (const res of [
        await owner.get(`/api/properties/${id}`),
        await owner.patch(`/api/properties/${id}`).send({ city: 'Lincoln' }),
        await owner.post(`/api/properties/${id}/archive`),
        await owner.post(`/api/properties/${id}/unarchive`),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: NOT_FOUND });
      }
    }
  });
});

describe('opening and listing addresses', () => {
  test('GET /:id answers with the same shape as the create', async () => {
    const p = await mustCreate(await who.as('office'), '/api/properties', { ...full, lat: 41.2, lng: -95.9 });
    const res = await (await who.as('owner')).get(`/api/properties/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(p);
  });

  async function three() {
    const owner = await who.as('owner');
    const molly = await mustCreate(owner, '/api/customers', { displayName: 'Molly' });
    const b = await mustCreate(owner, '/api/properties', { addressLine: '22 Birch Ln', city: 'Lincoln', state: 'NE', zip: '68508', customerId: molly.id });
    const a = await mustCreate(owner, '/api/properties', { addressLine: '9 Aspen Ct', city: 'Omaha', state: 'NE', zip: '68102' });
    const c = await mustCreate(owner, '/api/properties', { addressLine: '100 Cedar Rd', city: 'Omaha', state: 'NE', zip: '68144' });
    return { owner, molly, a, b, c };
  }
  const idsOf = (res: { body: { properties: { id: string }[] } }) => res.body.properties.map((p) => p.id);

  test('lists by street address, with the count before paging', async () => {
    const { owner, a, b, c } = await three();
    const res = await owner.get('/api/properties');
    expect(res.status).toBe(200);
    // 100 Cedar Rd, 22 Birch Ln, 9 Aspen Ct: alphabetical by the text, not by the number in it.
    expect(idsOf(res)).toEqual([c.id, b.id, a.id]);
    expect(res.body.total).toBe(3);
    const page = await owner.get('/api/properties?limit=1&offset=1');
    expect(idsOf(page)).toEqual([b.id]);
    expect(page.body.total).toBe(3);
  });

  test('?q= matches the street, city or ZIP in any case; ?customerId= narrows to one customer', async () => {
    const { owner, molly, a, b, c } = await three();
    expect(idsOf(await owner.get('/api/properties?q=aspen'))).toEqual([a.id]);
    expect(idsOf(await owner.get('/api/properties?q=lincoln'))).toEqual([b.id]);
    expect(idsOf(await owner.get('/api/properties?q=68144'))).toEqual([c.id]);
    expect((await owner.get('/api/properties?q=omaha')).body.total).toBe(2);
    expect((await owner.get('/api/properties?q=100%25')).body.total).toBe(0);
    expect(idsOf(await owner.get(`/api/properties?customerId=${molly.id}`))).toEqual([b.id]);
    expect((await owner.get(`/api/properties?customerId=${NO_UUID}`)).body).toEqual({ properties: [], total: 0 });
    const bad = await owner.get('/api/properties?customerId=molly');
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('customerId');
    expect((await owner.get(`/api/properties?q=${'x'.repeat(101)}`)).status).toBe(400);
  });

  test('archived addresses are left out unless ?includeArchived=true', async () => {
    const { owner, a, b, c } = await three();
    await owner.post(`/api/properties/${b.id}/archive`);
    expect(idsOf(await owner.get('/api/properties'))).toEqual([c.id, a.id]);
    expect(idsOf(await owner.get('/api/properties?includeArchived=true'))).toEqual([c.id, b.id, a.id]);
    expect((await owner.get('/api/properties?includeArchived=maybe')).status).toBe(400);
  });

  test('a bad limit or offset is a 400', async () => {
    const owner = await who.as('owner');
    expect((await owner.get('/api/properties?limit=abc')).body).toEqual({ error: 'Please use a whole number from 1 to 200.', field: 'limit' });
    expect((await owner.get('/api/properties?offset=-1')).body.field).toBe('offset');
  });
});

describe('archiving an address', () => {
  test('archive and unarchive use the app clock, are audited, and add timeline lines', async () => {
    const owner = await who.as('owner');
    const p = await mustCreate(owner, '/api/properties', full);
    t.clock.set(new Date('2026-10-15T08:00:00.000Z'));
    const archived = await owner.post(`/api/properties/${p.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toBe('2026-10-15T08:00:00.000Z');
    t.clock.set(new Date('2026-10-16T08:00:00.000Z'));
    const restored = await owner.post(`/api/properties/${p.id}/unarchive`);
    expect(restored.body.archivedAt).toBeNull();

    const [audited] = await dbAudit(t, A(), 'property.archive');
    expect(audited).toMatchObject({ targetType: 'property', targetId: p.id, before: { archivedAt: null }, after: { archivedAt: '2026-10-15T08:00:00.000Z' } });
    expect(await dbAudit(t, A(), 'property.unarchive')).toHaveLength(1);
    expect(await timeline(t, A(), p.id as string)).toEqual([
      ['property.archived', 'Address archived'],
      ['property.created', 'Address added'],
      ['property.unarchived', 'Address restored'],
    ]);
  });

  test('doing it twice changes nothing and writes nothing more', async () => {
    const owner = await who.as('owner');
    const p = await mustCreate(owner, '/api/properties', full);
    await owner.post(`/api/properties/${p.id}/archive`);
    t.clock.advance(3_600_000);
    const again = await owner.post(`/api/properties/${p.id}/archive`);
    expect(again.body.archivedAt).toBe('2026-10-12T15:00:00.000Z');
    expect(await dbAudit(t, A(), 'property.archive')).toHaveLength(1);
    const fresh = await mustCreate(owner, '/api/properties', addressFor(3));
    await owner.post(`/api/properties/${fresh.id}/unarchive`);
    expect(await dbAudit(t, A(), 'property.unarchive')).toHaveLength(0);
  });
});

describe('the constraint names the repository relies on are the database\'s own', () => {
  const insert = (values: Partial<typeof properties.$inferInsert>) =>
    inCompany(t, A(), (tx) =>
      tx.insert(properties).values({ companyId: A(), ...addressFor(0), addressKey: '100 oak st|68102', ...values }),
    ).then(
      () => undefined,
      (err: unknown) => findPgError(err),
    );

  test('a second address with the same key fails on the unique key; an unknown customer on the same-company key', async () => {
    expect(await insert({})).toBeUndefined();
    expect(await insert({})).toEqual({ code: '23505', constraint: 'properties_company_address_key_uniq' });
    expect(await insert({ addressKey: 'other|68102', customerId: NO_UUID })).toEqual({
      code: '23503',
      constraint: 'properties_company_customer_fk',
    });
  });
});

describe('reps tie new addresses to a customer', () => {
  const PICK = 'Pick the customer for this address.';

  test.each<[string, Record<string, unknown>]>([
    ['no customerId', {}],
    ['a null customerId', { customerId: null }],
  ])('a rep sending %s → 400 on customerId, and nothing is saved', async (_name, extra) => {
    const res = await (await who.as('rep')).post('/api/properties').send({ ...full, ...extra });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PICK, field: 'customerId' });
    expect(await inCompany(t, A(), (tx) => tx.select().from(properties))).toEqual([]);
    expect(await dbAudit(t, A(), 'property.create')).toEqual([]);
  });

  test('a rep with a customer they made can add the address and read it back', async () => {
    const rep = await who.as('rep');
    const mine = await mustCreate(rep, '/api/customers', { displayName: 'Rep customer' });
    const res = await rep.post('/api/properties').send({ ...full, customerId: mine.id });
    expect(res.status).toBe(201);
    expect(res.body.customerId).toBe(mine.id);
    expect((await rep.get(`/api/properties/${res.body.id}`)).status).toBe(200);
  });

  test('a rep must still name a customer they can see: someone else\'s is the usual 400', async () => {
    const theirs = await mustCreate(await who.as('owner'), '/api/customers', { displayName: "Owner's customer" });
    const res = await (await who.as('rep')).post('/api/properties').send({ ...full, customerId: theirs.id });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NO_CUSTOMER, field: 'customerId' });
  });

  test('the owner and the office may still add an address with no customer', async () => {
    for (const [n, member] of (['owner', 'office'] as const).entries()) {
      const res = await (await who.as(member)).post('/api/properties').send(addressFor(n));
      expect(res.status, member).toBe(201);
      expect(res.body.customerId, member).toBeNull();
    }
  });

  test('a rep cannot take the customer off an address; they can move it to another customer they can see', async () => {
    const rep = await who.as('rep');
    const first = await mustCreate(rep, '/api/customers', { displayName: 'First' });
    const second = await mustCreate(rep, '/api/customers', { displayName: 'Second' });
    const p = await mustCreate(rep, '/api/properties', { ...full, customerId: first.id });

    const cleared = await rep.patch(`/api/properties/${p.id}`).send({ customerId: null });
    expect(cleared.status).toBe(400);
    expect(cleared.body).toEqual({ error: PICK, field: 'customerId' });
    expect((await dbProperty(t, A(), p.id as string)).customerId).toBe(first.id);
    expect(await dbAudit(t, A(), 'property.update')).toEqual([]);

    const moved = await rep.patch(`/api/properties/${p.id}`).send({ customerId: second.id });
    expect(moved.status).toBe(200);
    expect(moved.body.customerId).toBe(second.id);
    // The owner can still clear it.
    const owner = await (await who.as('owner')).patch(`/api/properties/${p.id}`).send({ customerId: null });
    expect(owner.status).toBe(200);
  });

  test('the repository holds the same rule for a rep, and not for the system', async () => {
    const repCtx: TenantContext = { companyId: A(), userId: who.user('rep').userId, role: 'rep', canApproveSpend: false };
    const options = { now: t.clock.now() };
    await expect(withTenant(t.deps.pools, repCtx, (tx) => createProperty(tx, repCtx, full, options))).rejects.toBeInstanceOf(
      CustomerRequiredError,
    );
    const mine = await mustCreate(await who.as('rep'), '/api/customers', { displayName: 'Rep customer' });
    const made = await withTenant(t.deps.pools, repCtx, (tx) => createProperty(tx, repCtx, { ...full, customerId: mine.id }, options));
    await expect(
      withTenant(t.deps.pools, repCtx, (tx) => updateProperty(tx, repCtx, made.id, { customerId: null }, options)),
    ).rejects.toBeInstanceOf(CustomerRequiredError);
    const systemCtx: TenantContext = { ...repCtx, userId: null, role: 'system' };
    const loose = await withTenant(t.deps.pools, systemCtx, (tx) => createProperty(tx, systemCtx, addressFor(5), options));
    expect(loose.customerId).toBeNull();
  });
});

describe('giving an address to a customer that has jobs there', () => {
  const CONFLICT = 'This address already has jobs for a different customer.';
  const NEEDS_CUSTOMER = 'This address has jobs, so it needs a customer.';

  /** Two customers, and an address with no customer yet. */
  async function setup() {
    const owner = await who.as('owner');
    const x = await mustCreate(owner, '/api/customers', { displayName: 'X' });
    const y = await mustCreate(owner, '/api/customers', { displayName: 'Y' });
    const p = await mustCreate(owner, '/api/properties', full);
    return { owner, x, y, p };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;
  /** A job through the API. At an address nobody owns, it makes its customer the owner. */
  const job = (owner: Setup['owner'], customerId: unknown, propertyId: unknown, extra: Record<string, unknown> = {}) =>
    mustCreate(owner, '/api/jobs', { customerId, propertyId, ...extra });
  /** A job straight into the table: what the API can no longer make (data from before a job claimed its address, an import). */
  const legacyJob = (customerId: unknown, propertyId: unknown, extra: Partial<typeof jobs.$inferInsert> = {}) =>
    inCompany(t, A(), (tx) =>
      tx.insert(jobs).values({ companyId: A(), customerId: customerId as string, propertyId: propertyId as string, ...extra }),
    );

  test('a live job for another customer → 400 on customerId, and nothing changes', async () => {
    const { owner, x, y, p } = await setup();
    await job(owner, x.id, p.id); // the job makes X the owner of the address
    const updates = (await dbAudit(t, A(), 'property.update')).length;
    const res = await owner.patch(`/api/properties/${p.id}`).send({ customerId: y.id });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: CONFLICT, field: 'customerId' });
    expect((await dbProperty(t, A(), p.id as string)).customerId).toBe(x.id);
    expect(await dbAudit(t, A(), 'property.update')).toHaveLength(updates);
  });

  test('from no customer to the one every job is for is fine', async () => {
    const { owner, x, p } = await setup();
    await legacyJob(x.id, p.id);
    await legacyJob(x.id, p.id);
    const res = await owner.patch(`/api/properties/${p.id}`).send({ customerId: x.id });
    expect(res.status).toBe(200);
    expect(res.body.customerId).toBe(x.id);
  });

  test('one job for the customer and one for another (old data) → neither customer can have the address', async () => {
    const { owner, x, y, p } = await setup();
    await legacyJob(x.id, p.id);
    await legacyJob(y.id, p.id);
    for (const customerId of [x.id, y.id]) {
      const res = await owner.patch(`/api/properties/${p.id}`).send({ customerId });
      expect(res.body).toEqual({ error: CONFLICT, field: 'customerId' });
    }
  });

  test('an archived job does not count; restoring it makes it count again', async () => {
    const { owner, x, y, p } = await setup();
    const j = await job(owner, x.id, p.id);
    await owner.post(`/api/jobs/${j.id}/archive`);
    expect((await owner.patch(`/api/properties/${p.id}`).send({ customerId: y.id })).status).toBe(200);
    // The job is now for X at Y's address; restoring it does not make that consistent, but it is
    // a job-level rule (enforced when the job is made or changed), not this one.
    await owner.post(`/api/jobs/${j.id}/unarchive`);
    expect((await owner.patch(`/api/properties/${p.id}`).send({ customerId: x.id })).status).toBe(200);
    expect((await owner.patch(`/api/properties/${p.id}`).send({ customerId: y.id })).body.field).toBe('customerId');
  });

  test('the same customer again is fine', async () => {
    const { owner, x, p } = await setup();
    await job(owner, x.id, p.id);
    expect((await owner.patch(`/api/properties/${p.id}`).send({ customerId: x.id })).status).toBe(200);
  });

  test('the customer cannot be taken off an address that has a job, archived or not; with no job it can', async () => {
    const { owner, x, p } = await setup();
    const q = await mustCreate(owner, '/api/properties', addressFor(4));
    await owner.patch(`/api/properties/${q.id}`).send({ customerId: x.id });
    expect((await owner.patch(`/api/properties/${q.id}`).send({ customerId: null })).status).toBe(200);

    const j = await job(owner, x.id, p.id);
    const refused = await owner.patch(`/api/properties/${p.id}`).send({ customerId: null });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: NEEDS_CUSTOMER, field: 'customerId' });
    await owner.post(`/api/jobs/${j.id}/archive`);
    expect((await owner.patch(`/api/properties/${p.id}`).send({ customerId: null })).status).toBe(400);
    expect((await dbProperty(t, A(), p.id as string)).customerId).toBe(x.id);
  });

  test('an address with no jobs, and jobs at other addresses, never block', async () => {
    const { owner, x, y, p } = await setup();
    const other = await mustCreate(owner, '/api/properties', addressFor(3));
    await job(owner, x.id, other.id);
    expect((await owner.patch(`/api/properties/${p.id}`).send({ customerId: y.id })).status).toBe(200);
  });

  test("jobs a rep can't see count too", async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const c = await mustCreate(rep, '/api/customers', { displayName: 'Rep customer C' });
    const d = await mustCreate(rep, '/api/customers', { displayName: 'Rep customer D' });
    const p = await mustCreate(owner, '/api/properties', { ...full, customerId: c.id });
    // The job at C's address is another rep's, so the rep cannot see it; they see the address through C.
    await job(owner, c.id, p.id, { assignedUserId: who.user('otherRep').userId });
    expect((await rep.get(`/api/properties/${p.id}`)).status).toBe(200);
    const res = await rep.patch(`/api/properties/${p.id}`).send({ customerId: d.id });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: CONFLICT, field: 'customerId' });
  });
});
