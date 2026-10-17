import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  addActivity,
  calls,
  conversations,
  conversationTurns,
  createAppointment,
  createCustomer,
  createJob,
  createProperty,
  setServiceArea,
  withTenant,
  type GeoJsonMultiPolygon,
  type LngLat,
  type Pools,
  type TenantContext,
} from '@roofline/db';
import { findCompanyBySlug } from '@roofline/db/system';
import { type Query, seedCompany } from '@roofline/db/testing';
import type { JobStage } from '@roofline/shared';
import { systemContext } from '../permissions.ts';
import { createTask } from '../tasks/service.ts';
import { seedRidgewayWindows } from './demo-winchoice-windows.ts';
import { demoWorldCounts, seedAgentsDashboardActivity, type DemoWorld, type DemoWorldOptions } from './demo-world.ts';

/*
 * The second demo company, "WinChoice (demo)": a windows-first replacement company in Little Rock, Arkansas, so the
 * white-label switch is visible next to Summit Ridge Roofing (default blue brand): WinChoice wears #ED3A2B.
 *
 * It has its own owner (a separate user and login, not one person in two companies), an office user and two reps; the
 * instant quote page /q/winchoice with windows first and roofing second; twelve jobs across the pipeline at real-looking
 * central Arkansas addresses; three visits today and tomorrow; a Follow-up plan waiting for a yes; Front Desk calls and
 * texts; and the Agents dashboard's activity. Every person is invented (.test emails, 555 phone numbers).
 *
 * Idempotent like the Summit Ridge world: when a company with the slug exists it changes nothing and returns
 * `created: false`. `npm run demo` seeds it after Summit Ridge, so an older demo database gets it on the next run.
 */

export const DEMO_WINCHOICE_SLUG = 'winchoice-demo';
/** The demo's instant quote page: /q/winchoice. */
export const DEMO_WINCHOICE_QUOTE_SLUG = 'winchoice';
export const DEMO_WINCHOICE_NAME = 'WinChoice (demo)';
/** The brand colour the company wears: the app's primary action red. Stored as the quote page's accent colour. */
export const DEMO_WINCHOICE_BRAND_COLOR = '#ED3A2B';
/** A fictional, demo-only credential (every WinChoice demo user shares the password). */
export const DEMO_WINCHOICE_LOGIN = { email: 'owner@winchoice.test', password: 'winchoice-demo' } as const;
/** The company's own number, and the Front Desk number that answers for it. */
const COMPANY_PHONE = '+15015550140';
export const DEMO_WINCHOICE_NUMBER = '+15015550141';

export const DEMO_WINCHOICE_USERS = [
  { email: DEMO_WINCHOICE_LOGIN.email, name: 'Tara Whitlock', role: 'owner', canApproveSpend: true },
  { email: 'office@winchoice.test', name: 'Brandon Pruitt', role: 'office', canApproveSpend: false },
  { email: 'maddie@winchoice.test', name: 'Maddie Cavender', role: 'rep' },
  { email: 'caleb@winchoice.test', name: 'Caleb Strickland', role: 'rep' },
] as const;

const FRONT_DESK_FACTS =
  'Free in-home window estimates, usually within two days. We replace every window in the house in one visit and give one written price. Financing is available. Office hours: Mon-Fri 8 AM-5 PM, Sat 9 AM-1 PM. Serving Little Rock and central Arkansas.';

/** Central Arkansas: Little Rock, North Little Rock, Sherwood, Maumelle, Conway, Benton and Bryant all sit inside it. */
const SERVICE_AREA: GeoJsonMultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-92.75, 34.5],
        [-91.95, 34.5],
        [-91.95, 35.15],
        [-92.75, 35.15],
        [-92.75, 34.5],
      ],
    ],
  ],
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type JobSeed = {
  name: string;
  phone: string;
  address: string;
  city: string;
  zip: string;
  location: LngLat;
  stage: JobStage;
  valueCents: number | null;
  rep: 'maddie' | 'caleb' | null;
  /** How long ago the customer and job were made. */
  daysAgo: number;
  nextStep?: string;
  /** 'today' or 'tomorrow' (the company's day) for the next step's due date. */
  due?: 'today' | 'tomorrow';
  lostReason?: string;
};

/** The pipeline: 12 jobs in six stages. The first is the house the Measure windows demo is built on (305 Ridgeway Dr). */
export const WINCHOICE_JOBS: readonly JobSeed[] = [
  { name: 'Frank Delgado', phone: '+15015550201', address: '305 Ridgeway Dr', city: 'Little Rock', zip: '72205', location: [-92.3188, 34.7506], stage: 'proposal', valueCents: 587_000, rep: 'maddie', daysAgo: 4, nextStep: 'Send the window proposal', due: 'today' },
  { name: 'Linda Pruett', phone: '+15015550202', address: '2417 N Tyler St', city: 'Little Rock', zip: '72207', location: [-92.3327, 34.7418], stage: 'proposal', valueCents: 1_240_000, rep: 'caleb', daysAgo: 5, nextStep: 'Call about financing', due: 'tomorrow' },
  { name: 'Ronald Tackett', phone: '+15015550203', address: '1821 Rodney Parham Rd', city: 'Little Rock', zip: '72212', location: [-92.3561, 34.7642], stage: 'proposal', valueCents: 1_890_000, rep: 'maddie', daysAgo: 7 },
  { name: 'Sheila Moody', phone: '+15015550204', address: '5411 W 12th St', city: 'Little Rock', zip: '72204', location: [-92.3552, 34.7284], stage: 'won', valueCents: 1_420_000, rep: 'caleb', daysAgo: 9, nextStep: 'Order the windows', due: 'today' },
  { name: 'Gary Voss', phone: '+15015550205', address: '2208 Willow St', city: 'North Little Rock', zip: '72116', location: [-92.2641, 34.7693], stage: 'won', valueCents: 2_260_000, rep: 'maddie', daysAgo: 12, nextStep: 'Confirm the install day', due: 'tomorrow' },
  { name: 'Janet Holloway', phone: '+15015550206', address: '1105 Main St', city: 'North Little Rock', zip: '72114', location: [-92.2654, 34.7738], stage: 'installed', valueCents: 960_000, rep: 'caleb', daysAgo: 26 },
  { name: 'Curtis Beal', phone: '+15015550207', address: '1520 Donaghey Ave', city: 'Conway', zip: '72032', location: [-92.4478, 35.0884], stage: 'inspection', valueCents: null, rep: 'maddie', daysAgo: 2, nextStep: 'Window visit today at 10:30', due: 'today' },
  { name: 'Alma Reyes', phone: '+15015550208', address: '905 Oak St', city: 'Conway', zip: '72032', location: [-92.4421, 35.0857], stage: 'inspection', valueCents: null, rep: 'caleb', daysAgo: 3, nextStep: 'Window visit today at 1:00', due: 'today' },
  { name: 'Dwight Cannon', phone: '+15015550209', address: '112 Odom Blvd', city: 'Maumelle', zip: '72113', location: [-92.4109, 34.8662], stage: 'lead', valueCents: null, rep: null, daysAgo: 0, nextStep: 'Call about their instant quote', due: 'today' },
  { name: 'Tamika Rhodes', phone: '+15015550210', address: '2400 E Kiehl Ave', city: 'Sherwood', zip: '72120', location: [-92.2204, 34.8149], stage: 'lead', valueCents: null, rep: null, daysAgo: 1 },
  { name: 'Walt Ingram', phone: '+15015550211', address: '1301 Military Rd', city: 'Benton', zip: '72015', location: [-92.5869, 34.5645], stage: 'lead', valueCents: null, rep: null, daysAgo: 2 },
  { name: 'Beverly Stroud', phone: '+15015550212', address: '600 Reynolds Rd', city: 'Bryant', zip: '72022', location: [-92.4893, 34.6049], stage: 'lost', valueCents: 810_000, rep: 'maddie', daysAgo: 15, lostReason: 'Went with a local installer' },
];

type TurnSeed = { speaker: 'caller' | 'assistant' | 'team'; text: string; toolCalls?: { name: string; input: Record<string, unknown>; result: string; ok: boolean }[] };

/**
 * Makes the WinChoice world when no company has DEMO_WINCHOICE_SLUG; otherwise changes nothing and returns
 * `created: false`. `ownerUrl` connects as the table owner (the company and its users are written with it).
 */
export async function seedWinChoiceWorld(pools: Pools, ownerUrl: string, now: Date, opts: DemoWorldOptions = {}): Promise<DemoWorld> {
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  const q: Query = async (text, values) => (await owner.query(text, values)).rows as Record<string, unknown>[];
  try {
    // The rail under the company name reads "city, state": give Summit Ridge its city too (it only had the state).
    await q(`update companies set address_city = 'Omaha' where slug = 'summit-ridge-roofing' and address_city is null`);

    const existing = await findCompanyBySlug(pools.system, DEMO_WINCHOICE_SLUG);
    if (existing) return { created: false, companyId: existing.id, counts: await winChoiceCounts(q, existing.id) };

    const company = await seedCompany(ownerUrl, {
      name: DEMO_WINCHOICE_NAME,
      slug: DEMO_WINCHOICE_SLUG,
      timezone: 'America/Chicago',
      state: 'AR',
      phoneE164: COMPANY_PHONE,
      users: DEMO_WINCHOICE_USERS.map((u) => ({ ...u })),
      password: DEMO_WINCHOICE_LOGIN.password,
    });
    const { companyId } = company;
    const ctx = systemContext(companyId);
    const userId = (email: string) => company.users.find((u) => u.email === email)!.userId;
    const reps = { maddie: userId('maddie@winchoice.test'), caleb: userId('caleb@winchoice.test') } as const;
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const ahead = (ms: number) => new Date(now.getTime() + ms);

    // The company's profile and brand: a Little Rock office, and the red the app wears (the quote page's accent colour).
    await q(
      `update companies set legal_name = 'WinChoice (demo) LLC', email = 'office@winchoice.test', address_street = '8300 Rodney Parham Rd', address_city = 'Little Rock', address_state = 'AR', address_zip = '72227' where id = $1`,
      [companyId],
    );
    // Windows first, roofing second; no gutters. The instant quote page is /q/winchoice.
    await q(
      `update company_settings set quote_enabled = true, quote_slug = $2, quote_products = '{windows,roof}', quote_booking = true, quote_accent_color = $3,
              front_desk_enabled = true, front_desk_texts = true, forwarding_verified_at = $4, front_desk_facts = $5
        where company_id = $1`,
      [companyId, DEMO_WINCHOICE_QUOTE_SLUG, DEMO_WINCHOICE_BRAND_COLOR, ago(3 * DAY), FRONT_DESK_FACTS],
    );
    await q(
      `insert into company_phone_numbers (company_id, e164, capabilities, provider_sid) values ($1, $2, array['sms','voice'], 'PN_demo_winchoice')`,
      [companyId, DEMO_WINCHOICE_NUMBER],
    );

    const zoneDays = await q(`select (($1::timestamptz at time zone 'America/Chicago')::date)::text as today`, [now]);
    const today = String(zoneDays[0]!.today);
    /** `HH:MM` on the local (Chicago) day `days` from today, as an instant. */
    const localAt = async (days: number, hhmm: string): Promise<Date> => {
      const r = await q(`select (($1::date + $2::int) + $3::time) at time zone 'America/Chicago' as t`, [today, days, hhmm]);
      return new Date(r[0]!.t as Date);
    };
    const dayKey = async (days: number): Promise<string> => String((await q(`select (($1::date + $2::int))::text as d`, [today, days]))[0]!.d);

    // 1. The book: 12 customers with a job each, from lead to installed, one lost.
    const made: Record<string, { jobId: string; customerId: string; propertyId: string }> = {};
    await withTenant(pools, ctx, async (tx) => {
      await setServiceArea(tx, SERVICE_AREA);
      for (const seed of WINCHOICE_JOBS) {
        const at = ago(seed.daysAgo * DAY + 2 * HOUR);
        const [first, ...rest] = seed.name.split(' ');
        const customer = await createCustomer(
          tx,
          ctx,
          {
            displayName: seed.name,
            firstName: first ?? seed.name,
            lastName: rest.join(' ') || null,
            phones: [{ e164: seed.phone, label: 'mobile', primary: true }],
            emails: [`${(first ?? 'customer').toLowerCase()}.${rest.join('').toLowerCase()}@example.test`],
            smsConsentStatus: 'express',
          },
          { now: at },
        );
        const property = await createProperty(
          tx,
          ctx,
          { customerId: customer.id, addressLine: seed.address, city: seed.city, state: 'AR', zip: seed.zip, location: seed.location },
          { now: at },
        );
        const job = await createJob(
          tx,
          ctx,
          {
            customerId: customer.id,
            propertyId: property.id,
            stage: seed.stage,
            source: seed.stage === 'lead' ? 'web' : 'manual',
            valueCents: seed.valueCents,
            assignedUserId: seed.rep === null ? null : reps[seed.rep],
            lostReason: seed.lostReason ?? null,
            nextStep: seed.nextStep ?? null,
            nextStepOn: seed.due === undefined ? null : await dayKey(seed.due === 'today' ? 0 : 1),
          },
          { now: at },
        );
        made[seed.address] = { jobId: job.id, customerId: customer.id, propertyId: property.id };
        if (seed.stage === 'lead') {
          await addActivity(tx, ctx, { subjectType: 'job', subjectId: job.id, kind: 'note', summary: 'Asked for a window quote on the instant quote page.', at });
        }
      }

      // 2. Visits: two window visits today, a crew install tomorrow.
      const book = async (i: { kind: 'inspection' | 'install'; address: string; title: string; userId: string; start: Date; end: Date; source?: 'manual' | 'front_desk' }) => {
        const job = made[i.address]!;
        return createAppointment(
          tx,
          ctx,
          {
            kind: i.kind,
            title: i.title,
            jobId: job.jobId,
            customerId: job.customerId,
            propertyId: job.propertyId,
            assignedUserId: i.userId,
            startsAt: i.start,
            endsAt: i.end,
            allDay: false,
            notes: null,
            source: i.source ?? 'manual',
          },
          ago(2 * DAY),
        );
      };
      await book({ kind: 'inspection', address: '1520 Donaghey Ave', title: 'Window visit: Curtis Beal', userId: reps.maddie, start: await localAt(0, '10:30'), end: await localAt(0, '11:30') });
      await book({ kind: 'inspection', address: '905 Oak St', title: 'Window visit: Alma Reyes', userId: reps.caleb, start: await localAt(0, '13:00'), end: await localAt(0, '14:00'), source: 'front_desk' });
      await book({ kind: 'install', address: '2208 Willow St', title: 'Window install: Gary Voss', userId: reps.maddie, start: await localAt(1, '08:00'), end: await localAt(1, '16:00') });

      // 3. A Follow-up plan waiting for a yes: texts to the two newest web leads.
      const messages = ['2400 E Kiehl Ave', '1301 Military Rd'].map((address) => {
        const job = made[address]!;
        const seed = WINCHOICE_JOBS.find((j) => j.address === address)!;
        return {
          customerId: job.customerId,
          jobId: null,
          body: `Hi ${seed.name.split(' ')[0]}, it's ${DEMO_WINCHOICE_NAME}. Would Tuesday at 10 AM or Wednesday at 2 PM work for a free window estimate at your home?`,
        };
      });
      await createTask(
        tx,
        ctx,
        {
          agent: 'follow_up',
          kind: 'follow_ups',
          title: `Follow up with ${messages.length} leads`,
          summary: 'These leads asked for a window quote and have not heard back.',
          expiresAt: ahead(2 * DAY),
          steps: [{ type: 'send_personal_texts', payload: { purpose: 'informational', kind: 'lead', messages, dedupePrefix: 'demo:winchoice:follow_ups' } }],
        },
        { now: ago(40 * MINUTE), ip: null, allowInternalStepTypes: true },
      );
    });

    // 4. Front Desk: two calls with transcripts and two text threads.
    await seedFrontDesk(pools, ctx, now, DEMO_WINCHOICE_NAME, made);

    // 5. The Agents dashboard: finished work for all six agents.
    await seedAgentsDashboardActivity(q, companyId, now);

    // 6. Measure windows: 305 Ridgeway Dr, seven windows (four measured on site) and a draft factory order.
    const ridgeway = WINCHOICE_JOBS[0]!;
    await seedRidgewayWindows(
      pools,
      ctx,
      now,
      { propertyId: made[ridgeway.address]!.propertyId, address: `${ridgeway.address}, ${ridgeway.city}, AR ${ridgeway.zip}`, lngLat: [ridgeway.location[0], ridgeway.location[1]] },
      opts.objectStore,
    );

    return { created: true, companyId, counts: await winChoiceCounts(q, companyId) };
  } finally {
    await owner.end();
  }
}

/** The world's counts, plus its window measurements and factory orders. */
async function winChoiceCounts(q: Query, companyId: string): Promise<Record<string, number>> {
  const one = async (sql: string): Promise<number> => Number((await q(sql, [companyId]))[0]?.n ?? 0);
  return {
    ...(await demoWorldCounts(q, companyId)),
    windowMeasurements: await one(`select count(*) as n from window_measurements where company_id = $1`),
    windowOrders: await one(`select count(*) as n from window_orders where company_id = $1`),
  };
}

/** The callers Front Desk knows by name: two new customers (a home each, no job yet). The third caller gave a first name and no number on file. */
const FRONT_DESK_PEOPLE = {
  denise: { name: 'Denise Harlan', phone: '+15015550331', address: '7420 Kanis Rd', zip: '72204', location: [-92.3721, 34.7468] as LngLat },
  marcus: { name: 'Marcus Tillery', phone: '+15015550334', address: '310 Pleasant Valley Dr', zip: '72212', location: [-92.3702, 34.7581] as LngLat },
  ernest: { phone: '+15015550332' },
} as const;

/**
 * The Front Desk threads: two calls (a booked window visit, an urgent message) and two text threads. The callers who booked have a
 * name and a home (Denise Harlan and Marcus Tillery are new customers); the texter is Dwight Cannon, the Maumelle lead of the pipeline;
 * Ernest, who left the urgent message, is the one caller not yet on file. The text-back thread opens with the text Front Desk sent.
 */
async function seedFrontDesk(
  pools: Pools,
  ctx: TenantContext,
  now: Date,
  companyName: string,
  made: Record<string, { jobId: string; customerId: string; propertyId: string }>,
): Promise<void> {
  const { companyId } = ctx;
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE);
  await withTenant(pools, ctx, async (tx) => {
    const newCustomer = async (p: { name: string; phone: string; address: string; zip: string; location: LngLat }): Promise<string> => {
      const [first, ...rest] = p.name.split(' ');
      const customer = await createCustomer(
        tx,
        ctx,
        { displayName: p.name, firstName: first ?? p.name, lastName: rest.join(' ') || null, phones: [{ e164: p.phone, label: 'mobile', primary: true }], smsConsentStatus: 'express' },
        { now: at(60 * 24 * 2) },
      );
      await createProperty(tx, ctx, { customerId: customer.id, addressLine: p.address, city: 'Little Rock', state: 'AR', zip: p.zip, location: p.location }, { now: at(60 * 24 * 2) });
      return customer.id;
    };
    const denise = FRONT_DESK_PEOPLE.denise;
    const marcus = FRONT_DESK_PEOPLE.marcus;
    const deniseId = await newCustomer(denise);
    const marcusId = await newCustomer(marcus);
    const dwight = WINCHOICE_JOBS.find((job) => job.name === 'Dwight Cannon')!;
    const dwightId = made[dwight.address]!.customerId;

    const conversation = async (o: {
      channel: 'voice' | 'sms';
      phone: string;
      customerId?: string | null;
      outcome?: 'booked' | 'message' | null;
      unread?: number;
      summary?: string | null;
      minutesAgo: number;
      identity?: 'unknown' | 'matched';
    }): Promise<string> => {
      const [row] = await tx
        .insert(conversations)
        .values({
          companyId,
          channel: o.channel,
          customerId: o.customerId ?? null,
          phoneE164: o.phone,
          companyNumberE164: DEMO_WINCHOICE_NUMBER,
          outcome: o.outcome ?? null,
          unreadCount: o.unread ?? 0,
          summary: o.summary ?? null,
          identity: o.identity ?? 'unknown',
          lastMessageAt: at(o.minutesAgo),
        })
        .returning({ id: conversations.id });
      return row!.id;
    };
    const call = async (conversationId: string, from: string, minutesAgo: number, aiSeconds: number): Promise<string> => {
      const pickupMs = 600 + ((aiSeconds * 37) % 7) * 100;
      const [row] = await tx
        .insert(calls)
        .values({
          companyId,
          conversationId,
          callSid: `CA${randomUUID().replace(/-/g, '')}`,
          fromE164: from,
          toE164: DEMO_WINCHOICE_NUMBER,
          status: 'ended',
          startedAt: at(minutesAgo),
          aiStartedAt: new Date(at(minutesAgo).getTime() + pickupMs),
          endedAt: new Date(at(minutesAgo).getTime() + pickupMs + aiSeconds * 1000),
          aiSeconds,
          transcriptStored: true,
          recordingStatus: 'none',
        })
        .returning({ id: calls.id });
      return row!.id;
    };
    const turns = async (conversationId: string, callId: string | null, list: TurnSeed[], minutesAgo: number, spacing = 0.3): Promise<void> => {
      for (const [position, turn] of list.entries()) {
        await tx.insert(conversationTurns).values({
          companyId,
          conversationId,
          callId,
          position,
          speaker: turn.speaker,
          text: turn.text,
          at: at(minutesAgo - position * spacing),
          toolCalls: turn.toolCalls ?? null,
        });
      }
    };

    const windowCall = await conversation({
      channel: 'voice',
      phone: denise.phone,
      customerId: deniseId,
      outcome: 'booked',
      unread: 1,
      summary: 'Denise wants quotes on all 14 windows in her house and booked a free visit for Thursday at 10:00 AM.',
      identity: 'matched',
      minutesAgo: 34,
    });
    const windowCallId = await call(windowCall, denise.phone, 37, 151);
    await turns(
      windowCall,
      windowCallId,
      [
        { speaker: 'assistant', text: `Thanks for calling ${companyName}. I'm the virtual assistant, and this call is recorded. How can I help?` },
        { speaker: 'caller', text: 'Hi, I want prices to replace all the windows in my house. They are original from 1994 and drafty.' },
        { speaker: 'assistant', text: 'We can do that. A rep measures every window at a free visit and gives you one written price. Is Thursday at 10:00 AM or Friday at 2:00 PM better?' },
        { speaker: 'caller', text: 'Thursday morning works.' },
        {
          speaker: 'assistant',
          text: 'You are booked for Thursday at 10:00 AM. You will get a text to confirm, and Maddie from our team will come out.',
          toolCalls: [{ name: 'book_inspection', input: { day: 'Thursday', time: '10:00' }, result: 'Booked', ok: true }],
        },
        { speaker: 'caller', text: 'Great, thank you.' },
      ],
      37,
    );

    const messageCall = await conversation({
      channel: 'voice',
      phone: FRONT_DESK_PEOPLE.ernest.phone,
      outcome: 'message',
      unread: 1,
      summary: 'A caller has a cracked bedroom window that will not close and asked for a call back today.',
      minutesAgo: 95,
    });
    const messageCallId = await call(messageCall, FRONT_DESK_PEOPLE.ernest.phone, 98, 84);
    await turns(
      messageCall,
      messageCallId,
      [
        { speaker: 'assistant', text: `Thanks for calling ${companyName}. I'm the virtual assistant, and this call is recorded. How can I help?` },
        { speaker: 'caller', text: 'The glass in my bedroom window cracked and the sash will not close. Can someone call me back today?' },
        { speaker: 'assistant', text: 'I am marking this urgent. Can I get your name and the address?' },
        { speaker: 'caller', text: 'Ernest, 4720 Kavanaugh Blvd in Little Rock.' },
        {
          speaker: 'assistant',
          text: 'Thank you, Ernest. I have taken your message and marked it urgent. Someone from our team will call you back shortly.',
          toolCalls: [{ name: 'take_message', input: { urgent: true }, result: 'Taken', ok: true }],
        },
      ],
      98,
    );

    const textA = await conversation({ channel: 'sms', phone: dwight.phone, customerId: dwightId, unread: 2, identity: 'matched', minutesAgo: 8 });
    await turns(
      textA,
      null,
      [
        { speaker: 'assistant', text: `Hi, this is ${companyName}. Sorry we missed your call. How can we help?` },
        { speaker: 'caller', text: 'Hi, do you replace windows in Maumelle? I need a price for 9 of them.' },
        { speaker: 'caller', text: 'I can be home any afternoon this week.' },
      ],
      12,
      2,
    );

    const textB = await conversation({
      channel: 'sms',
      phone: marcus.phone,
      customerId: marcusId,
      outcome: 'booked',
      summary: 'Marcus asked about financing and booked a Saturday window visit.',
      identity: 'matched',
      minutesAgo: 210,
    });
    await turns(
      textB,
      null,
      [
        { speaker: 'caller', text: 'Do you offer financing for new windows?' },
        { speaker: 'assistant', text: 'We do. Monthly payment options are shown on every proposal. Would you like a free visit first?' },
        { speaker: 'caller', text: 'Yes please, Saturday morning if possible.' },
        {
          speaker: 'assistant',
          text: 'You are booked for Saturday at 9:00 AM. Reply here if anything changes.',
          toolCalls: [{ name: 'book_inspection', input: { day: 'Saturday', time: '09:00' }, result: 'Booked', ok: true }],
        },
        { speaker: 'caller', text: 'Thank you!' },
      ],
      220,
      2,
    );
  });
}
