import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { calendarConnections, decrypt, type TenantContext } from '@roofline/db';
import { readOAuthState } from '../src/calendar/oauth-state.ts';
import { accessTokenFor } from '../src/calendar/tokens.ts';
import { CalendarAuthError, type ExternalCalendar } from '../src/providers/calendar.ts';
import { Actors, dbAudit, inCompany, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const CONNECT = '/api/calendar/connect/google';
const CALLBACK = '/api/calendar/oauth/google/callback';
const CONNECTION = '/api/calendar/connection';

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  actors = new Actors(t);
});

/** The `state` query value of a redirect Location, decoded. */
function stateOf(location: string | undefined): string {
  const state = new URL(location ?? 'https://invalid.test/').searchParams.get('state');
  if (state === null) throw new Error(`No state in ${location}`);
  return state;
}

function settingsUrl(result: string): string {
  return `${t.deps.config.APP_ORIGIN}/settings/connections?calendar=${result}`;
}

/** Mints a state the way the app does: by asking the connect route as this member. */
async function mintState(who: 'owner' | 'office' | 'rep' | 'otherRep', company: 'a' | 'b' = 'a'): Promise<string> {
  const agent = await actors.as(who, company);
  const res = await agent.get(CONNECT);
  expect(res.status).toBe(302);
  return stateOf(res.headers.location);
}

function callbackWith(agent: SuperAgent, state: string) {
  return agent.get(`${CALLBACK}?code=abc&state=${encodeURIComponent(state)}`);
}

/** Connects company A's owner through the real callback. */
async function connectOwner(): Promise<SuperAgent> {
  const owner = await actors.as('owner');
  const state = await mintState('owner');
  const res = await callbackWith(owner, state);
  expect(res.headers.location).toBe(settingsUrl('connected'));
  return owner;
}

function connectionRows(companyId: string) {
  return inCompany(t, companyId, (tx) => tx.select().from(calendarConnections).where(eq(calendarConnections.companyId, companyId)));
}

test('connect redirects to the provider with a signed state', async () => {
  const owner = await actors.as('owner');
  const res = await owner.get(CONNECT);
  expect(res.status).toBe(302);
  const location = res.headers.location ?? '';
  expect(location.startsWith('https://calendar.fake.test/google/auth?state=')).toBe(true);
  const claims = readOAuthState(stateOf(location), t.deps.config.ENCRYPTION_KEY, t.clock.now());
  expect(claims?.companyId).toBe(t.seed.a.companyId);
  expect(claims?.userId).toBe(t.seed.a.owner.userId);
  expect(claims?.provider).toBe('google');
});

test('an unconfigured provider redirects to not-set-up', async () => {
  Object.defineProperty(t.deps.calendars.microsoft, 'configured', { value: false });
  const owner = await actors.as('owner');
  const res = await owner.get('/api/calendar/connect/microsoft');
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`${t.deps.config.APP_ORIGIN}/settings/connections?calendar=not-set-up`);
});

test('an unknown provider is not found', async () => {
  const owner = await actors.as('owner');
  const res = await owner.get('/api/calendar/connect/yahoo');
  expect(res.status).toBe(404);
  expect(res.body.error).toBe(NOT_FOUND);
});

test('the callback saves an encrypted connection, picks the primary calendar, audits and redirects', async () => {
  const owner = await actors.as('owner');
  const state = await mintState('owner');
  const res = await callbackWith(owner, state);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(settingsUrl('connected'));

  const rows = await connectionRows(t.seed.a.companyId);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  const primary = (await t.calendars.google.listCalendars('access-abc')).find((c) => c.primary)!;
  expect(row.provider).toBe('google');
  expect(row.accountEmail).toBe('abc@example.test');
  expect(row.calendarId).toBe(primary.id);
  expect(row.status).toBe('connected');
  expect(Buffer.isBuffer(row.encryptedCredentials)).toBe(true);
  expect(row.encryptedCredentials.toString('utf8').includes('refresh-abc')).toBe(false);
  expect(JSON.parse(decrypt(row.encryptedCredentials, t.deps.config.ENCRYPTION_KEY))).toEqual({ refreshToken: 'refresh-abc' });

  const audits = await dbAudit(t, t.seed.a.companyId, 'calendar.connected');
  expect(audits).toHaveLength(1);
  expect(audits[0]!.after).toEqual({ provider: 'google' });

  const view = await owner.get(CONNECTION);
  expect(view.status).toBe(200);
  expect(view.body.status).toBe('connected');
  expect(view.body.accountEmail).toBe('abc@example.test');
  expect(view.body.configured).toEqual({ google: true, microsoft: true });
  const text = JSON.stringify(view.body);
  expect(text.includes('refresh-abc')).toBe(false);
  expect(text.includes('encrypted')).toBe(false);
});

test('a state minted for another user is refused', async () => {
  const state = await mintState('owner');
  const office = await actors.as('office');
  const res = await callbackWith(office, state);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(settingsUrl('failed'));
  const mine = (await connectionRows(t.seed.a.companyId)).filter((r) => r.userId === t.seed.a.office.userId);
  expect(mine).toHaveLength(0);
});

test('a state from another company is refused', async () => {
  const state = await mintState('owner', 'b');
  const owner = await actors.as('owner', 'a');
  const res = await callbackWith(owner, state);
  expect(res.headers.location).toBe(settingsUrl('failed'));
  expect(await connectionRows(t.seed.a.companyId)).toHaveLength(0);
});

test('an expired state is refused', async () => {
  const state = await mintState('owner');
  t.clock.advance(11 * 60 * 1000);
  const owner = await actors.as('owner');
  const res = await callbackWith(owner, state);
  expect(res.headers.location).toBe(settingsUrl('failed'));
  expect(await connectionRows(t.seed.a.companyId)).toHaveLength(0);
});

test('a reused state is refused', async () => {
  const state = await mintState('owner');
  const owner = await actors.as('owner');
  expect((await callbackWith(owner, state)).headers.location).toBe(settingsUrl('connected'));
  expect((await callbackWith(owner, state)).headers.location).toBe(settingsUrl('failed'));
  expect(await connectionRows(t.seed.a.companyId)).toHaveLength(1);
});

test('access denied is canceled', async () => {
  const state = await mintState('owner');
  const owner = await actors.as('owner');
  const res = await owner.get(`${CALLBACK}?error=access_denied&state=${encodeURIComponent(state)}`);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(settingsUrl('canceled'));
  expect(await connectionRows(t.seed.a.companyId)).toHaveLength(0);
});

test('the user can change the calendar', async () => {
  // The fake offers one writable calendar; this test adds a second writable one and a read-only one.
  const fake = t.calendars.google;
  const listed = fake.listCalendars.bind(fake);
  fake.listCalendars = async (token: string): Promise<ExternalCalendar[]> => [
    ...(await listed(token)),
    { id: 'work', name: 'Work', primary: false, canWrite: true },
    { id: 'holidays', name: 'Holidays', primary: false, canWrite: false },
  ];

  const owner = await connectOwner();
  const list = await owner.get(`${CONNECTION}/calendars`);
  expect(list.status).toBe(200);
  const ids = (list.body as ExternalCalendar[]).map((c) => c.id);
  expect(ids).toContain('primary');
  expect(ids).toContain('work');
  expect(ids).not.toContain('holidays');
  expect((list.body as ExternalCalendar[]).every((c) => c.canWrite === true)).toBe(true);

  const changed = await owner.patch(CONNECTION).send({ calendarId: 'work' });
  expect(changed.status).toBe(200);
  expect(changed.body.calendarId).toBe('work');
  expect(changed.body.calendarName).toBe('Work');

  const unknown = await owner.patch(CONNECTION).send({ calendarId: 'nope' });
  expect(unknown.status).toBe(400);
  expect(unknown.body.error).toBe('Pick one of your calendars.');

  const readOnly = await owner.patch(CONNECTION).send({ calendarId: 'holidays' });
  expect(readOnly.status).toBe(400);
  expect(readOnly.body.error).toBe('Pick one of your calendars.');
});

test('disconnect removes the connection', async () => {
  const owner = await connectOwner();
  const res = await owner.delete(CONNECTION);
  expect(res.status).toBe(204);
  expect(res.text ?? '').toBe('');

  const view = await owner.get(CONNECTION);
  expect(view.body.status).toBeNull();
  expect(await connectionRows(t.seed.a.companyId)).toHaveLength(0);
  expect(await dbAudit(t, t.seed.a.companyId, 'calendar.disconnected')).toHaveLength(1);

  const again = await owner.delete(CONNECTION);
  expect(again.status).toBe(404);
  expect(again.body.error).toBe(NOT_FOUND);
});

test('a revoked grant turns the connection to error once', async () => {
  const owner = await connectOwner();
  const row = (await connectionRows(t.seed.a.companyId))[0]!;
  t.calendars.google.revoke('refresh-abc');

  const ctx: TenantContext = {
    companyId: t.seed.a.companyId,
    userId: t.seed.a.owner.userId,
    role: 'owner',
    canApproveSpend: true,
  };
  await expect(accessTokenFor(t.deps, ctx, row)).rejects.toBeInstanceOf(CalendarAuthError);

  const view = await owner.get(CONNECTION);
  expect(view.body.status).toBe('error');
  const after = (await connectionRows(t.seed.a.companyId))[0]!;
  expect(after.lastErrorPlain).toBe('Reconnect your calendar.');
});

test('sync answers 202 with a connection and 404 without', async () => {
  const owner = await actors.as('owner');
  const before = await owner.post('/api/calendar/sync').send({});
  expect(before.status).toBe(404);
  expect(before.body.error).toBe(NOT_FOUND);

  await connectOwner();
  const after = await owner.post('/api/calendar/sync').send({});
  expect(after.status).toBe(202);
});

test('each member only sees their own connection', async () => {
  await connectOwner();
  const office = await actors.as('office');
  const seen = await office.get(CONNECTION);
  expect(seen.status).toBe(200);
  expect(seen.body.status).toBeNull();

  const rep = await actors.as('rep');
  const removed = await rep.delete(CONNECTION);
  expect(removed.status).toBe(404);
  expect(await connectionRows(t.seed.a.companyId)).toHaveLength(1);
});

test('company B cannot touch company A connection', async () => {
  await connectOwner();
  const other = await actors.as('owner', 'b');
  const view = await other.get(CONNECTION);
  expect(view.status).toBe(200);
  expect(view.body.status).toBeNull();

  const removed = await other.delete(CONNECTION);
  expect(removed.status).toBe(404);
  expect(removed.body.error).toBe(NOT_FOUND);
  expect(await connectionRows(t.seed.a.companyId)).toHaveLength(1);
});
