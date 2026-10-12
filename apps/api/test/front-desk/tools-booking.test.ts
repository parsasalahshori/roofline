import { asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  appointments,
  companyPhoneNumbers,
  companySettings,
  createProperty,
  customers,
  encrypt,
  getAppointmentView,
  insertConversation,
  jobs,
  messages,
  properties,
  textingRegistrations,
  type TenantContext,
} from '@roofline/db';
import type { ConsentStatus, IdentityLevel } from '@roofline/shared';
import type { ConversationState, ToolContext } from '../../src/front-desk/engine-types.ts';
import { newConversationState } from '../../src/front-desk/state.ts';
import { BOOK_FAILED, bookInspection, isAvailable as bookAvailable } from '../../src/front-desk/tools/book.ts';
import {
  confirmAppointmentTool,
  confirmByText,
  isAvailable as confirmAvailable,
  isConfirmShortcut,
  NOT_VERIFIED,
  NOTHING_TO_CONFIRM,
} from '../../src/front-desk/tools/confirm.ts';
import {
  CANCEL_OFF,
  cancelInspection,
  isCancelAvailable,
  isMoveAvailable,
  MOVE_OFF,
  moveInspection,
  NOT_VERIFIED_CHANGE,
  ONLY_INSPECTIONS,
} from '../../src/front-desk/tools/move.ts';
import {
  ADDRESS_NOT_FOUND,
  findInspectionTimes,
  isAvailable as timesAvailable,
  LOOKUP_DOWN,
  openInspectionSlots,
  OUTSIDE_AREA,
} from '../../src/front-desk/tools/times.ts';
import { dbActivities, inCompany } from '../crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';
import { DAYTIME } from '../sms-helpers.ts';

/*
 * D1 Task 8: the booking tools run against the real database with the fake geocoder, the fake SMS
 * provider and the recording job queue. Handlers are called the way the engine calls them, with a
 * conversation state. Database-backed: CI runs it.
 */

let t: TestApp;

const A_NUMBER = '+14025550100';
const TOKEN = 'test-subaccount-token-a';
const CALLER = '+14025550177';
const ADDRESS = '123 Elm St, Omaha, NE 68102';
/** Wednesday 14 October 2026, 10:00 in Chicago (CDT): DAYTIME is the Tuesday before. */
const WED_10 = '2026-10-14T15:00:00.000Z';
const WED_1030 = '2026-10-14T15:30:00.000Z';
const WED_11 = '2026-10-14T16:00:00.000Z';
const THU_10 = '2026-10-15T15:00:00.000Z';
const HOUR_MS = 60 * 60 * 1000;
const OMAHA_BOX = 'POLYGON((-97 40.5, -95 40.5, -95 42, -97 42, -97 40.5))';
const DENVER_BOX = 'POLYGON((-105.1 39.6, -104.8 39.6, -104.8 39.9, -105.1 39.9, -105.1 39.6))';

const A = () => t.seed.a.companyId;
const owner = () => t.seed.a.owner.userId;
const rep = () => t.seed.a.rep.userId;
const otherRep = () => t.seed.a.otherRep.userId;
const sys = (): TenantContext => ({ companyId: A(), userId: null, role: 'system', canApproveSpend: false });

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  await t.deps.pools.system
    .insert(companyPhoneNumbers)
    .values({ companyId: A(), e164: A_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, A()));
  await setSettings({ frontDeskEnabled: true, frontDeskTexts: true, frontDeskCanMove: true, frontDeskCanCancel: true });
});

async function setSettings(values: Partial<typeof companySettings.$inferInsert>) {
  await inCompany(t, A(), (tx) =>
    tx
      .insert(companySettings)
      .values({ companyId: A(), ...values })
      .onConflictDoUpdate({ target: companySettings.companyId, set: values }),
  );
}

async function startConversation(o: {
  channel?: 'voice' | 'sms';
  phone?: string;
  identity?: IdentityLevel;
  customerId?: string | null;
} = {}): Promise<ConversationState> {
  const channel = o.channel ?? 'voice';
  const phone = o.phone ?? CALLER;
  const { id } = await inCompany(t, A(), (tx) =>
    insertConversation(tx, sys(), {
      channel,
      phoneE164: phone,
      companyNumberE164: A_NUMBER,
      customerId: o.customerId ?? null,
      identity: o.identity ?? 'unknown',
    }),
  );
  const state = newConversationState({
    companyId: A(),
    conversationId: id,
    channel,
    phone,
    callId: null,
    companyBlock: '',
    repName: null,
    startedAt: t.clock.now(),
  });
  state.identity = o.identity ?? 'unknown';
  state.customerId = o.customerId ?? null;
  return state;
}

const toolCtx = (state: ConversationState): ToolContext => ({ deps: t.deps, companyId: A(), conversation: state, now: t.clock.now() });

type BookInput = Parameters<typeof bookInspection>[1];
const bookInput = (over: Partial<BookInput> = {}): BookInput => ({
  slotStart: WED_10,
  slotUserId: owner(),
  propertyId: null,
  address: ADDRESS,
  firstName: 'Rita',
  lastName: 'Gomez',
  notes: 'Leak over the garage',
  ...over,
});

const OPTION = /slotStart (\S+), slotUserId ([0-9a-f-]{36})/g;
const optionsOf = (text: string) => [...text.matchAll(OPTION)].map((m) => ({ slotStart: m[1]!, slotUserId: m[2]! }));

const ZONE = 'America/Chicago';
const hourIn = (iso: string) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));
const weekdayIn = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short' }).format(new Date(iso));

const allAppointments = () => inCompany(t, A(), (tx) => tx.select().from(appointments).orderBy(asc(appointments.createdAt), asc(appointments.id)));
const allCustomers = () => inCompany(t, A(), (tx) => tx.select().from(customers));
const allJobs = () => inCompany(t, A(), (tx) => tx.select().from(jobs));
const allMessages = () => inCompany(t, A(), (tx) => tx.select().from(messages).where(eq(messages.direction, 'out')).orderBy(asc(messages.createdAt)));
const pushes = () => t.jobs.sent.filter((j) => j.name === 'calendar-push');

/** A visit written straight into the table. */
async function seedVisit(o: {
  userId: string | null;
  start: string;
  end?: string;
  kind?: 'inspection' | 'install' | 'adjuster';
  customerId?: string | null;
  propertyId?: string | null;
  allDay?: boolean;
  confirmedAt?: Date | null;
}): Promise<string> {
  const start = new Date(o.start);
  const [row] = await inCompany(t, A(), (tx) =>
    tx
      .insert(appointments)
      .values({
        companyId: A(),
        kind: o.kind ?? 'inspection',
        customerId: o.customerId ?? null,
        propertyId: o.propertyId ?? null,
        assignedUserId: o.userId,
        startsAt: start,
        endsAt: o.end !== undefined ? new Date(o.end) : new Date(start.getTime() + HOUR_MS),
        allDay: o.allDay ?? false,
        status: 'scheduled',
        source: 'manual',
        confirmedAt: o.confirmedAt ?? null,
        confirmedVia: o.confirmedAt ? 'manual' : null,
      })
      .returning({ id: appointments.id }),
  );
  return row!.id;
}

/** Every inspector busy at one start (a visit each). */
async function everyoneBusy(start: string, propertyId: string | null = null) {
  for (const userId of [owner(), rep(), otherRep()]) await seedVisit({ userId, start, propertyId });
}

/** A customer with a number and a home. */
async function seedCustomer(o: { phone?: string; secondPhone?: string; consent?: ConsentStatus; address?: string } = {}) {
  const now = t.clock.now();
  return inCompany(t, A(), async (tx) => {
    const [row] = await tx
      .insert(customers)
      .values({
        companyId: A(),
        displayName: 'Nina Park',
        firstName: 'Nina',
        lastName: 'Park',
        phones: [
          { e164: o.phone ?? CALLER, label: 'mobile', primary: true },
          ...(o.secondPhone ? [{ e164: o.secondPhone, label: 'mobile', primary: false }] : []),
        ],
        smsConsentStatus: o.consent ?? 'express',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: customers.id });
    const home = await createProperty(
      tx,
      sys(),
      { customerId: row!.id, addressLine: o.address ?? '9 Maple Ave', city: 'Omaha', state: 'NE', zip: '68102', timezone: ZONE },
      { now },
    );
    return { customerId: row!.id, propertyId: home.id };
  });
}

/** Two homes with no customer, for the buffer tests. */
async function twoHomes() {
  return inCompany(t, A(), async (tx) => {
    const now = t.clock.now();
    const one = await createProperty(tx, sys(), { addressLine: '101 Oak St', city: 'Omaha', state: 'NE', zip: '68102' }, { now });
    const two = await createProperty(tx, sys(), { addressLine: '102 Oak St', city: 'Omaha', state: 'NE', zip: '68102' }, { now });
    return { home1: one.id, home2: two.id };
  });
}

async function setServiceArea(wkt: string) {
  await inCompany(t, A(), (tx) =>
    tx.execute(sql`update companies set service_area = ST_Multi(ST_GeomFromText(${wkt}, 4326)) where id = ${A()}`),
  );
}

describe('find_inspection_times', () => {
  test('offers at most 6 times, by part of day, inside work hours and after the notice', async () => {
    const state = await startConversation();
    const res = await findInspectionTimes(toolCtx(state), { propertyId: null, address: null, fromDate: null, partOfDay: 'any' });
    expect(res.ok).toBe(true);
    const options = optionsOf(res.forModel);
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThanOrEqual(6);
    expect(res.forModel).toContain('Morning:');
    expect(res.forModel).toContain('Afternoon:');
    const earliest = t.clock.now().getTime() + 2 * HOUR_MS;
    for (const o of options) {
      expect(new Date(o.slotStart).getTime()).toBeGreaterThanOrEqual(earliest);
      expect(weekdayIn(o.slotStart)).not.toBe('Sun');
      expect(hourIn(o.slotStart)).toBeGreaterThanOrEqual(8);
      expect(hourIn(o.slotStart)).toBeLessThanOrEqual(17);
    }
  });

  test('a part of day keeps only that part', async () => {
    const state = await startConversation();
    const morning = await findInspectionTimes(toolCtx(state), { propertyId: null, address: null, fromDate: '2026-10-14', partOfDay: 'morning' });
    const afternoon = await findInspectionTimes(toolCtx(state), { propertyId: null, address: null, fromDate: '2026-10-14', partOfDay: 'afternoon' });
    expect(optionsOf(morning.forModel).length).toBeGreaterThan(0);
    for (const o of optionsOf(morning.forModel)) expect(hourIn(o.slotStart)).toBeLessThan(12);
    expect(optionsOf(afternoon.forModel).length).toBeGreaterThan(0);
    for (const o of optionsOf(afternoon.forModel)) expect(hourIn(o.slotStart)).toBeGreaterThanOrEqual(12);
  });

  test('looks 10 days ahead and no further', async () => {
    const state = await startConversation();
    const res = await findInspectionTimes(toolCtx(state), { propertyId: null, address: null, fromDate: null, partOfDay: 'any' });
    const last = t.clock.now().getTime() + 10 * 24 * HOUR_MS;
    for (const o of optionsOf(res.forModel)) expect(new Date(o.slotStart).getTime()).toBeLessThan(last);
  });

  test('a day with no work hours has no times', async () => {
    const world = await inCompany(t, A(), (tx) =>
      openInspectionSlots(tx, sys(), {
        from: new Date('2026-10-18T05:00:00.000Z'),
        to: new Date('2026-10-19T05:00:00.000Z'),
        propertyId: null,
        now: t.clock.now(),
      }),
    );
    expect(world.slots).toEqual([]);
  });

  test('a visit at another home keeps a 30-minute buffer; at the same home it does not', async () => {
    const { home1, home2 } = await twoHomes();
    // Thursday 10:00-11:00 Chicago at home1, for every inspector.
    await everyoneBusy(THU_10, home1);
    const from = new Date('2026-10-15T05:00:00.000Z');
    const to = new Date('2026-10-16T05:00:00.000Z');
    const startsFor = async (propertyId: string) => {
      const world = await inCompany(t, A(), (tx) => openInspectionSlots(tx, sys(), { from, to, propertyId, now: t.clock.now() }));
      return world.slots.map((s) => s.start.toISOString());
    };

    const other = await startsFor(home2);
    expect(other).toContain('2026-10-15T13:30:00.000Z'); // 08:30 ends 30 minutes before the visit
    expect(other).toContain('2026-10-15T16:30:00.000Z'); // 11:30 starts 30 minutes after it
    for (const h of ['14:00', '14:30', '15:00', '15:30', '16:00']) expect(other).not.toContain(`2026-10-15T${h}:00.000Z`);

    const same = await startsFor(home1);
    expect(same).toContain('2026-10-15T14:00:00.000Z'); // 09:00, right before
    expect(same).toContain('2026-10-15T16:00:00.000Z'); // 11:00, right after
    expect(same).not.toContain('2026-10-15T15:00:00.000Z');
    expect(same).not.toContain('2026-10-15T15:30:00.000Z');
  });

  test('a home that is on file counts for the buffer through the handler too', async () => {
    const { home1, home2 } = await twoHomes();
    await everyoneBusy(THU_10, home1);
    const state = await startConversation();
    const res = await findInspectionTimes(toolCtx(state), { propertyId: home2, address: null, fromDate: '2026-10-15', partOfDay: 'morning' });
    expect(res.ok).toBe(true);
    for (const o of optionsOf(res.forModel)) {
      const ms = new Date(o.slotStart).getTime();
      const visit = new Date(THU_10).getTime();
      expect(ms > visit - 90 * 60 * 1000 && ms < visit + 90 * 60 * 1000).toBe(false);
    }
  });

  test('an address with no home on file is looked up on the map first', async () => {
    const state = await startConversation();
    const res = await findInspectionTimes(toolCtx(state), { propertyId: null, address: ADDRESS, fromDate: null, partOfDay: 'any' });
    expect(res.ok).toBe(true);
    expect(t.geocoder.calls.some((c) => c.method === 'geocode' && c.args[0] === ADDRESS)).toBe(true);
    expect(optionsOf(res.forModel).length).toBeGreaterThan(0);
  });

  test('outside the service area: no times, a message suggestion', async () => {
    await setServiceArea(DENVER_BOX);
    const state = await startConversation();
    const res = await findInspectionTimes(toolCtx(state), { propertyId: null, address: ADDRESS, fromDate: null, partOfDay: 'any' });
    expect(res).toMatchObject({ ok: false, forModel: OUTSIDE_AREA, action: 'outside_area' });
    expect(OUTSIDE_AREA).toContain('take_message');
  });

  test('inside the service area, an unknown address and a map outage are told plainly', async () => {
    await setServiceArea(OMAHA_BOX);
    const state = await startConversation();
    const inside = await findInspectionTimes(toolCtx(state), { propertyId: null, address: ADDRESS, fromDate: null, partOfDay: 'any' });
    expect(inside.ok).toBe(true);
    const missing = await findInspectionTimes(toolCtx(state), { propertyId: null, address: '1 Nowhere Rd, Nowhere, NE 68000', fromDate: null, partOfDay: 'any' });
    expect(missing).toMatchObject({ ok: false, forModel: ADDRESS_NOT_FOUND });
    const down = await findInspectionTimes(toolCtx(state), { propertyId: null, address: '5 Outage Ln, Omaha, NE 68102', fromDate: null, partOfDay: 'any' });
    expect(down).toMatchObject({ ok: false, forModel: LOOKUP_DOWN });
  });
});

describe('book_inspection', () => {
  test('books a new caller in one go: customer, call consent, home, Lead job, front_desk appointment, push, text', async () => {
    const state = await startConversation();
    const res = await bookInspection(toolCtx(state), bookInput());
    expect(res).toMatchObject({ ok: true, action: 'booked' });
    expect(res.forModel).toContain('Wednesday, October 14 at 10:00 AM');
    expect(res.forModel).toContain('123 Elm St');

    const [customer] = await allCustomers();
    expect(customer).toMatchObject({
      displayName: 'Rita Gomez',
      source: 'call',
      smsConsentStatus: 'express',
      smsConsentSource: 'call',
    });
    expect(customer!.phones).toEqual([{ e164: CALLER, primary: true }]);

    const homes = await inCompany(t, A(), (tx) => tx.select().from(properties));
    expect(homes).toHaveLength(1);
    expect(homes[0]).toMatchObject({ addressLine: '123 Elm St', city: 'Omaha', state: 'NE', zip: '68102', customerId: customer!.id });

    const [job] = await allJobs();
    expect(job).toMatchObject({ source: 'front_desk', customerId: customer!.id, propertyId: homes[0]!.id });
    // C1's inspection auto-move: booking an inspection moves a Lead to Inspection.
    expect(job!.stage).toBe('inspection');

    const appts = await allAppointments();
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({
      kind: 'inspection',
      source: 'front_desk',
      status: 'scheduled',
      assignedUserId: owner(),
      jobId: job!.id,
      customerId: customer!.id,
      propertyId: homes[0]!.id,
      notes: 'Leak over the garage',
    });
    expect(appts[0]!.startsAt.toISOString()).toBe(WED_10);
    expect(appts[0]!.endsAt.toISOString()).toBe(WED_11);

    // The calendar push goes out through the queue.
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]).toMatchObject({ data: { companyId: A(), appointmentId: appts[0]!.id } });

    // The confirmation text went through the gate.
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]!.to).toBe(CALLER);
    expect(t.sms.sent[0]!.body).toMatch(
      /^You're booked: Wed Oct 14, 10:00 AM with \S+ from .+ at 123 Elm St\. Reply C to confirm or call us to change\.$/,
    );
    const texts = await allMessages();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ status: 'sent', purpose: 'informational', conversationId: state.conversationId });
    expect(res.shownIds).toContain(appts[0]!.id);
  });

  test('a slot taken meanwhile returns the next two and writes nothing', async () => {
    const state = await startConversation();
    // The owner got busy after the times were offered.
    await seedVisit({ userId: owner(), start: WED_10 });
    const res = await bookInspection(toolCtx(state), bookInput());
    expect(res.ok).toBe(false);
    expect(res.forModel).toContain('just taken');
    const options = optionsOf(res.forModel);
    expect(options).toHaveLength(2);
    expect(options.some((o) => o.slotStart === WED_10 && o.slotUserId === owner())).toBe(false);
    for (const o of options) expect(new Date(o.slotStart).getTime()).toBeGreaterThanOrEqual(new Date(WED_10).getTime());

    expect(await allAppointments()).toHaveLength(1); // only the seeded visit
    expect(await allCustomers()).toHaveLength(0);
    expect(await allJobs()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
    expect(pushes()).toHaveLength(0);
  });

  test('when every inspector is busy at that time the next two are later times', async () => {
    const state = await startConversation();
    await everyoneBusy(WED_10);
    const res = await bookInspection(toolCtx(state), bookInput());
    expect(res.ok).toBe(false);
    const options = optionsOf(res.forModel);
    expect(options).toHaveLength(2);
    for (const o of options) expect(new Date(o.slotStart).getTime()).toBeGreaterThan(new Date(WED_10).getTime());
  });

  test('the same conversation and slot gives the same appointment, and one text', async () => {
    const state = await startConversation();
    const first = await bookInspection(toolCtx(state), bookInput());
    const second = await bookInspection(toolCtx(state), bookInput());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.shownIds?.[0]).toBe(first.shownIds?.[0]);
    expect(second.forModel).toBe(first.forModel);
    expect(await allAppointments()).toHaveLength(1);
    expect(await allCustomers()).toHaveLength(1);
    expect(await allJobs()).toHaveLength(1);
    expect(t.sms.sent).toHaveLength(1);
    expect(pushes().length).toBeGreaterThan(0);
    expect(new Set(pushes().map((p) => p.singletonKey)).size).toBe(1);
  });

  test('two tries at once still make one appointment', async () => {
    const state = await startConversation();
    const [a, b] = await Promise.all([bookInspection(toolCtx(state), bookInput()), bookInspection(toolCtx(state), bookInput())]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.shownIds?.[0]).toBe(b.shownIds?.[0]);
    expect(await allAppointments()).toHaveLength(1);
    expect(t.sms.sent).toHaveLength(1);
  });

  test('another slot in the same conversation is another appointment on the same customer, home and job', async () => {
    const state = await startConversation();
    await bookInspection(toolCtx(state), bookInput());
    const again = await bookInspection(toolCtx(state), bookInput({ slotStart: THU_10 }));
    expect(again.ok).toBe(true);
    expect(await allAppointments()).toHaveLength(2);
    expect(await allCustomers()).toHaveLength(1);
    expect(await allJobs()).toHaveLength(1);
    expect(await inCompany(t, A(), (tx) => tx.select().from(properties))).toHaveLength(1);
  });

  test('two callers cannot take one inspector at one time', async () => {
    const one = await startConversation({ phone: '+14025550181' });
    const two = await startConversation({ phone: '+14025550182' });
    const [a, b] = await Promise.all([
      bookInspection(toolCtx(one), bookInput({ firstName: 'Ann', lastName: 'One' })),
      bookInspection(toolCtx(two), bookInput({ firstName: 'Bob', lastName: 'Two', address: '77 Pine St, Omaha, NE 68102' })),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await allAppointments()).toHaveLength(1);
  });

  test('outside the service area: nothing is made, a message is suggested', async () => {
    await setServiceArea(DENVER_BOX);
    const state = await startConversation();
    const res = await bookInspection(toolCtx(state), bookInput());
    expect(res).toMatchObject({ ok: false, forModel: OUTSIDE_AREA });
    expect(await allCustomers()).toHaveLength(0);
    expect(await allAppointments()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('a caller the number already matches is reused, with their open job at that home', async () => {
    const { customerId, propertyId } = await seedCustomer({ consent: 'none' });
    const job = await inCompany(t, A(), async (tx) => {
      const [row] = await tx
        .insert(jobs)
        .values({ companyId: A(), customerId, propertyId, stage: 'lead', source: 'web', stageChangedAt: t.clock.now(), createdAt: t.clock.now(), updatedAt: t.clock.now() })
        .returning({ id: jobs.id });
      return row!.id;
    });
    const state = await startConversation({ identity: 'matched', customerId });
    const res = await bookInspection(toolCtx(state), bookInput({ propertyId, address: null, firstName: '', lastName: '' }));
    expect(res.ok).toBe(true);
    expect(await allCustomers()).toHaveLength(1);
    expect(await allJobs()).toHaveLength(1);
    const [appt] = await allAppointments();
    expect(appt).toMatchObject({ jobId: job, customerId, propertyId, source: 'front_desk' });
    // The call is express consent for appointment texts, for a customer who had none.
    const [customer] = await allCustomers();
    expect(customer).toMatchObject({ smsConsentStatus: 'express', smsConsentSource: 'call' });
    expect(t.sms.sent).toHaveLength(1);
  });

  test('the confirmation goes to the number the conversation is on when it is the customer\'s second number', async () => {
    const SECOND = '+14025550177';
    const { customerId, propertyId } = await seedCustomer({ secondPhone: SECOND });
    const state = await startConversation({ channel: 'sms', phone: SECOND, identity: 'matched', customerId });
    const res = await bookInspection(toolCtx(state), bookInput({ propertyId, address: null }));
    expect(res.ok).toBe(true);
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]!.to).toBe(SECOND);
  });

  test('a conversation phone that is not one of the customer\'s numbers still gets the text on the primary number', async () => {
    const { customerId, propertyId } = await seedCustomer({ secondPhone: '+14025550177' });
    const state = await startConversation({ channel: 'sms', phone: '+14025550199', identity: 'matched', customerId });
    const res = await bookInspection(toolCtx(state), bookInput({ propertyId, address: null }));
    expect(res.ok).toBe(true);
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]!.to).toBe(CALLER);
  });

  test('a confirmation text the gate blocks is recorded, and the booking stands', async () => {
    const { customerId, propertyId } = await seedCustomer({ consent: 'revoked' });
    const state = await startConversation({ identity: 'matched', customerId });
    const res = await bookInspection(toolCtx(state), bookInput({ propertyId, address: null }));
    expect(res.ok).toBe(true);
    expect(res.forModel).toContain('No text could be sent');
    expect(await allAppointments()).toHaveLength(1);
    expect(t.sms.sent).toHaveLength(0);
    const texts = await allMessages();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ status: 'blocked', conversationId: state.conversationId });
    expect(texts[0]!.body).toContain("You're booked");
  });

  test('a text that fails to send leaves the booking standing', async () => {
    const state = await startConversation();
    t.sms.failNext(1);
    const res = await bookInspection(toolCtx(state), bookInput());
    expect(res.ok).toBe(true);
    expect(await allAppointments()).toHaveLength(1);
  });

  test('a new caller must give a name; a number several customers share is not guessed', async () => {
    const noName = await bookInspection(toolCtx(await startConversation()), bookInput({ firstName: '', lastName: '' }));
    expect(noName.ok).toBe(false);
    expect(await allAppointments()).toHaveLength(0);

    await seedCustomer({ phone: '+14025550166' });
    // A second customer on the same number, written straight in as an import would.
    await inCompany(t, A(), (tx) =>
      tx.insert(customers).values({
        companyId: A(),
        displayName: 'Nick Park',
        phones: [{ e164: '+14025550166', primary: true }],
        createdAt: t.clock.now(),
        updatedAt: t.clock.now(),
      }),
    );
    const shared = await bookInspection(toolCtx(await startConversation({ phone: '+14025550166' })), bookInput());
    expect(shared.ok).toBe(false);
    expect(await allAppointments()).toHaveLength(0);
  });

  test('only an inspector (an owner or a rep) can be booked', async () => {
    const state = await startConversation();
    const res = await bookInspection(toolCtx(state), bookInput({ slotUserId: t.seed.a.office.userId }));
    expect(res.ok).toBe(false);
    expect(await allAppointments()).toHaveLength(0);
    expect(await allCustomers()).toHaveLength(0);
  });

  test("a typed address that is another customer's home gets the neutral sentence, not who owns it (pre-review #30)", async () => {
    await seedCustomer({ phone: '+14025550166', address: '123 Elm St' });
    const state = await startConversation();
    const res = await bookInspection(toolCtx(state), bookInput({ propertyId: null, address: ADDRESS }));
    expect(res.ok).toBe(false);
    expect(res.forModel).toBe(BOOK_FAILED);
    expect(res.forModel).not.toMatch(/someone else|on file/i);
    expect(await allAppointments()).toHaveLength(0);
  });

  test('a home on file for someone else is not booked for a new caller', async () => {
    const { propertyId } = await seedCustomer({ phone: '+14025550166' });
    const state = await startConversation();
    const res = await bookInspection(toolCtx(state), bookInput({ propertyId }));
    expect(res.ok).toBe(false);
    expect(await allAppointments()).toHaveLength(0);
  });
});

describe('confirm_appointment', () => {
  async function verified(channel: 'voice' | 'sms' = 'voice') {
    const { customerId, propertyId } = await seedCustomer();
    const state = await startConversation({ channel, identity: 'verified', customerId });
    return { state, customerId, propertyId };
  }

  test('confirms any kind of visit for the verified caller, by call', async () => {
    const { state, customerId, propertyId } = await verified();
    const install = await seedVisit({
      userId: owner(),
      kind: 'install',
      start: '2026-10-20T05:00:00.000Z',
      end: '2026-10-21T05:00:00.000Z',
      allDay: true,
      customerId,
      propertyId,
    });
    const res = await confirmAppointmentTool(toolCtx(state), { appointmentId: install });
    expect(res).toMatchObject({ ok: true, action: 'confirmed' });
    expect(res.forModel).toContain('install');
    const [row] = await allAppointments();
    expect(row!.confirmedAt?.toISOString()).toBe(t.clock.now().toISOString());
    expect(row!.confirmedVia).toBe('call');
    const [conversation] = await inCompany(t, A(), (tx) => tx.execute(sql`select outcome from conversations where id = ${state.conversationId}`).then((r) => r.rows));
    expect(conversation).toMatchObject({ outcome: 'confirmed' });
  });

  test('a text conversation records the text', async () => {
    const { state, customerId, propertyId } = await verified('sms');
    const id = await seedVisit({ userId: owner(), start: WED_10, customerId, propertyId });
    const res = await confirmAppointmentTool(toolCtx(state), { appointmentId: id });
    expect(res.ok).toBe(true);
    expect((await allAppointments())[0]!.confirmedVia).toBe('text');
  });

  test('the appointment view the web reads carries confirmedAt and confirmedVia', async () => {
    const { state, customerId, propertyId } = await verified();
    const id = await seedVisit({ userId: owner(), start: WED_10, customerId, propertyId });
    const before = await inCompany(t, A(), (tx) => getAppointmentView(tx, sys(), id));
    expect(before).toMatchObject({ confirmedAt: null, confirmedVia: null });
    await confirmAppointmentTool(toolCtx(state), { appointmentId: id });
    const after = await inCompany(t, A(), (tx) => getAppointmentView(tx, sys(), id));
    expect(after).toMatchObject({ confirmedAt: t.clock.now().toISOString(), confirmedVia: 'call' });
  });

  test('confirming twice says so and changes nothing', async () => {
    const { state, customerId, propertyId } = await verified();
    const id = await seedVisit({ userId: owner(), start: WED_10, customerId, propertyId });
    await confirmAppointmentTool(toolCtx(state), { appointmentId: id });
    t.clock.advance(HOUR_MS);
    const again = await confirmAppointmentTool(toolCtx(state), { appointmentId: id });
    expect(again.ok).toBe(true);
    expect(again.forModel).toContain('already confirmed');
    expect((await allAppointments())[0]!.confirmedAt?.getTime()).toBe(DAYTIME.getTime());
  });

  test('an unverified caller cannot confirm', async () => {
    const { customerId, propertyId } = await seedCustomer();
    const id = await seedVisit({ userId: owner(), start: WED_10, customerId, propertyId });
    for (const identity of ['unknown', 'matched'] as const) {
      const state = await startConversation({ identity, customerId: identity === 'matched' ? customerId : null });
      const res = await confirmAppointmentTool(toolCtx(state), { appointmentId: id });
      expect(res).toMatchObject({ ok: false, forModel: NOT_VERIFIED });
    }
    expect((await allAppointments())[0]!.confirmedAt).toBeNull();
  });

  test("another customer's visit cannot be confirmed", async () => {
    const { state } = await verified();
    const other = await seedCustomer({ phone: '+14025550166', address: '5 Cedar Ct' });
    const id = await seedVisit({ userId: owner(), start: WED_10, customerId: other.customerId, propertyId: other.propertyId });
    const res = await confirmAppointmentTool(toolCtx(state), { appointmentId: id });
    expect(res.ok).toBe(false);
    expect((await allAppointments())[0]!.confirmedAt).toBeNull();
  });
});

describe('the C / confirm text', () => {
  test('which texts count', () => {
    for (const yes of ['C', 'c', ' Confirm ', 'confirm.', 'CONFIRM!']) expect(isConfirmShortcut(yes)).toBe(true);
    for (const no of ['Can you come Thursday?', 'cancel', 'C 2pm', 'confirmed', '']) expect(isConfirmShortcut(no)).toBe(false);
  });

  test('confirms the next visit that is not confirmed yet, one text at a time', async () => {
    const { customerId, propertyId } = await seedCustomer();
    const state = await startConversation({ channel: 'sms', identity: 'matched', customerId });
    const first = await seedVisit({ userId: owner(), start: WED_10, customerId, propertyId });
    const second = await seedVisit({ userId: owner(), start: THU_10, customerId, propertyId });
    const reply1 = await confirmByText(t.deps, { companyId: A(), conversationId: state.conversationId, customerId }, t.clock.now());
    expect(reply1).toBe('Thanks, your inspection on Wed Oct 14, 10:00 AM is confirmed.');
    let rows = await allAppointments();
    expect(rows.find((r) => r.id === first)).toMatchObject({ confirmedVia: 'text' });
    expect(rows.find((r) => r.id === second)!.confirmedAt).toBeNull();

    const reply2 = await confirmByText(t.deps, { companyId: A(), conversationId: state.conversationId, customerId }, t.clock.now());
    expect(reply2).toBe('Thanks, your inspection on Thu Oct 15, 10:00 AM is confirmed.');
    rows = await allAppointments();
    expect(rows.every((r) => r.confirmedAt !== null)).toBe(true);

    const reply3 = await confirmByText(t.deps, { companyId: A(), conversationId: state.conversationId, customerId }, t.clock.now());
    expect(reply3).toBe('Your inspection on Wed Oct 14, 10:00 AM is already confirmed.');
  });

  test('with no visit to confirm it says so', async () => {
    const { customerId } = await seedCustomer();
    const state = await startConversation({ channel: 'sms', identity: 'matched', customerId });
    const reply = await confirmByText(t.deps, { companyId: A(), conversationId: state.conversationId, customerId }, t.clock.now());
    expect(reply).toBe(NOTHING_TO_CONFIRM);
  });

  test("a canceled or past visit is not confirmed, and another customer's is left alone", async () => {
    const { customerId, propertyId } = await seedCustomer();
    const other = await seedCustomer({ phone: '+14025550166', address: '5 Cedar Ct' });
    await seedVisit({ userId: owner(), start: WED_10, customerId: other.customerId, propertyId: other.propertyId });
    await seedVisit({ userId: owner(), start: '2026-10-12T15:00:00.000Z', customerId, propertyId }); // yesterday
    const state = await startConversation({ channel: 'sms', identity: 'matched', customerId });
    const reply = await confirmByText(t.deps, { companyId: A(), conversationId: state.conversationId, customerId }, t.clock.now());
    expect(reply).toBe(NOTHING_TO_CONFIRM);
    expect((await allAppointments()).every((r) => r.confirmedAt === null)).toBe(true);
  });
});

describe('move_inspection', () => {
  async function withInspection(over: { kind?: 'inspection' | 'install'; confirmed?: boolean } = {}) {
    const { customerId, propertyId } = await seedCustomer();
    const state = await startConversation({ identity: 'verified', customerId });
    const id = await seedVisit({
      userId: owner(),
      start: WED_10,
      customerId,
      propertyId,
      kind: over.kind ?? 'inspection',
      ...(over.kind === 'install' && { allDay: true, end: '2026-10-15T15:00:00.000Z' }),
      ...(over.confirmed && { confirmedAt: new Date('2026-10-13T14:00:00.000Z') }),
    });
    return { state, customerId, propertyId, id };
  }

  test("moves the caller's own inspection, clears the confirmation, queues the calendar push", async () => {
    const { state, customerId, id } = await withInspection({ confirmed: true });
    const res = await moveInspection(toolCtx(state), { appointmentId: id, slotStart: THU_10, slotUserId: rep() });
    expect(res).toMatchObject({ ok: true, action: 'moved' });
    expect(res.forModel).toContain('Thursday, October 15 at 10:00 AM');
    const [row] = await allAppointments();
    expect(row).toMatchObject({ assignedUserId: rep(), confirmedAt: null, confirmedVia: null, status: 'scheduled' });
    expect(row!.startsAt.toISOString()).toBe(THU_10);
    expect(row!.endsAt.getTime() - row!.startsAt.getTime()).toBe(HOUR_MS);
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]).toMatchObject({ data: { companyId: A(), appointmentId: id } });
    const lines = await dbActivities(t, A(), customerId);
    expect(lines.some((l) => l.kind === 'appointment.moved')).toBe(true);
  });

  test('a visit does not block its own new time', async () => {
    const { state, id } = await withInspection();
    const res = await moveInspection(toolCtx(state), { appointmentId: id, slotStart: WED_1030, slotUserId: owner() });
    expect(res.ok).toBe(true);
    expect((await allAppointments())[0]!.startsAt.toISOString()).toBe(WED_1030);
  });

  test('a new time that was taken returns the next two and leaves the visit alone', async () => {
    const { state, id } = await withInspection();
    await everyoneBusy(THU_10);
    const res = await moveInspection(toolCtx(state), { appointmentId: id, slotStart: THU_10, slotUserId: rep() });
    expect(res.ok).toBe(false);
    expect(res.forModel).toContain('just taken');
    expect(optionsOf(res.forModel)).toHaveLength(2);
    const mine = (await allAppointments()).find((r) => r.id === id)!;
    expect(mine.startsAt.toISOString()).toBe(WED_10);
    expect(pushes()).toHaveLength(0);
  });

  test('an unverified caller cannot move', async () => {
    const { customerId, propertyId } = await seedCustomer();
    const id = await seedVisit({ userId: owner(), start: WED_10, customerId, propertyId });
    for (const identity of ['unknown', 'matched'] as const) {
      const state = await startConversation({ identity, customerId: identity === 'matched' ? customerId : null });
      const res = await moveInspection(toolCtx(state), { appointmentId: id, slotStart: THU_10, slotUserId: rep() });
      expect(res).toMatchObject({ ok: false, forModel: NOT_VERIFIED_CHANGE });
    }
    expect((await allAppointments())[0]!.startsAt.toISOString()).toBe(WED_10);
  });

  test('an install is refused with a message suggestion', async () => {
    const { state, id } = await withInspection({ kind: 'install' });
    const res = await moveInspection(toolCtx(state), { appointmentId: id, slotStart: THU_10, slotUserId: rep() });
    expect(res).toMatchObject({ ok: false, forModel: ONLY_INSPECTIONS });
    expect(ONLY_INSPECTIONS).toContain('take_message');
    expect((await allAppointments())[0]!.startsAt.toISOString()).toBe(WED_10);
  });

  test("another customer's inspection is not found", async () => {
    const { state } = await withInspection();
    const other = await seedCustomer({ phone: '+14025550166', address: '5 Cedar Ct' });
    const id = await seedVisit({ userId: rep(), start: THU_10, customerId: other.customerId, propertyId: other.propertyId });
    const res = await moveInspection(toolCtx(state), { appointmentId: id, slotStart: WED_11, slotUserId: rep() });
    expect(res.ok).toBe(false);
    expect((await allAppointments()).find((r) => r.id === id)!.startsAt.toISOString()).toBe(THU_10);
  });

  test('with moving switched off it is refused', async () => {
    const { state, id } = await withInspection();
    await setSettings({ frontDeskCanMove: false });
    const res = await moveInspection(toolCtx(state), { appointmentId: id, slotStart: THU_10, slotUserId: rep() });
    expect(res).toMatchObject({ ok: false, forModel: MOVE_OFF });
    expect((await allAppointments())[0]!.startsAt.toISOString()).toBe(WED_10);
  });
});

describe('cancel_inspection', () => {
  async function withInspection(kind: 'inspection' | 'install' = 'inspection') {
    const { customerId, propertyId } = await seedCustomer();
    const state = await startConversation({ identity: 'verified', customerId });
    const id = await seedVisit({
      userId: owner(),
      start: WED_10,
      customerId,
      propertyId,
      kind,
      ...(kind === 'install' && { allDay: true, end: '2026-10-15T15:00:00.000Z' }),
    });
    return { state, customerId, id };
  }

  test("cancels the caller's own inspection with the reason, and queues the calendar push", async () => {
    const { state, customerId, id } = await withInspection();
    const res = await cancelInspection(toolCtx(state), { appointmentId: id, reason: 'We sold the house' });
    expect(res).toMatchObject({ ok: true, action: 'canceled' });
    const [row] = await allAppointments();
    expect(row).toMatchObject({ status: 'canceled' });
    expect(row!.canceledAt).not.toBeNull();
    expect(pushes()).toHaveLength(1);
    const lines = await dbActivities(t, A(), customerId);
    expect(lines.some((l) => l.kind === 'appointment.canceled' && l.summary.includes('We sold the house'))).toBe(true);
  });

  test('an unverified caller cannot cancel', async () => {
    const { customerId, id } = await withInspection();
    const state = await startConversation({ identity: 'matched', customerId });
    const res = await cancelInspection(toolCtx(state), { appointmentId: id, reason: 'x' });
    expect(res).toMatchObject({ ok: false, forModel: NOT_VERIFIED_CHANGE });
    expect((await allAppointments())[0]!.status).toBe('scheduled');
    expect(pushes()).toHaveLength(0);
  });

  test('an install is refused with a message suggestion', async () => {
    const { state, id } = await withInspection('install');
    const res = await cancelInspection(toolCtx(state), { appointmentId: id, reason: 'x' });
    expect(res).toMatchObject({ ok: false, forModel: ONLY_INSPECTIONS });
    expect((await allAppointments())[0]!.status).toBe('scheduled');
  });

  test('with canceling switched off it is refused', async () => {
    const { state, id } = await withInspection();
    await setSettings({ frontDeskCanCancel: false });
    const res = await cancelInspection(toolCtx(state), { appointmentId: id, reason: 'x' });
    expect(res).toMatchObject({ ok: false, forModel: CANCEL_OFF });
    expect((await allAppointments())[0]!.status).toBe('scheduled');
  });

  test('canceling twice finds nothing the second time', async () => {
    const { state, id } = await withInspection();
    await cancelInspection(toolCtx(state), { appointmentId: id, reason: 'x' });
    const again = await cancelInspection(toolCtx(state), { appointmentId: id, reason: 'x' });
    expect(again.ok).toBe(false);
    expect(pushes()).toHaveLength(1);
  });
});

describe('the tool list', () => {
  const on = { canMove: true, canCancel: true };

  test('times, book and confirm are always offered', () => {
    for (const settings of [on, { canMove: false, canCancel: false }]) {
      expect(timesAvailable(settings)).toBe(true);
      expect(bookAvailable(settings)).toBe(true);
      expect(confirmAvailable(settings)).toBe(true);
    }
  });

  test('move and cancel are offered only when their switch is on', () => {
    expect(isMoveAvailable(on)).toBe(true);
    expect(isCancelAvailable(on)).toBe(true);
    expect(isMoveAvailable({ canMove: false, canCancel: true })).toBe(false);
    expect(isCancelAvailable({ canMove: false, canCancel: true })).toBe(true);
    expect(isMoveAvailable({ canMove: true, canCancel: false })).toBe(true);
    expect(isCancelAvailable({ canMove: true, canCancel: false })).toBe(false);
  });
});
