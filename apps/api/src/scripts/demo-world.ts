import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import {
  addActivity,
  addProposalEvent,
  calls,
  conversations,
  conversationTurns,
  createAppointment,
  createCustomer,
  createJob,
  createMeasurement,
  createProperty,
  createProposal,
  encrypt,
  footprintsNear,
  getMeasurementBasics,
  mintProposalLink,
  publicProposalView,
  recordSignedDocument,
  saveClaim,
  setPropertyFootprint,
  signProposal,
  withTenant,
  type LngLat,
  type Pools,
  type TenantContext,
  type ToolCallRecord,
  type Tx,
} from '@roofline/db';
import { findCompanyBySlug } from '@roofline/db/system';
import { OMAHA_CONTOURS, type Query, seedCompany } from '@roofline/db/testing';
import { CONSENT_TEXT_V1, canonicalJson, instantEstimate, signedDocument, type JobStage, type Outline } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { systemClock } from '../clock.ts';
import { makeSignedPdf } from '../estimator/signed-pdf.ts';
import type { ObjectStore } from '../providers/object-store.ts';
import { priceOptions, validUntilFor, noteDrafted, DEFAULT_PROPOSAL_MESSAGE } from '../estimator/build.ts';
import { settleSentProposal } from '../estimator/proposal-sent.ts';
import { systemContext } from '../permissions.ts';
import { draftStormPlan } from '../storm/plan.ts';
import { createTask } from '../tasks/service.ts';
import { DemoPlacer, hailOver } from '../demo/places.ts';
import { seedFootprintFixture } from './footprint-fixture.ts';
import { seedShowcase } from './showcase.ts';
import { seedStormFixture } from './storm-fixture.ts';

/*
 * The demo world: one fictional company, "Summit Ridge Roofing", with everything a walkthrough shows.
 * The showcase book (customers and jobs in every stage), a hail storm from yesterday with the homes it
 * hit and a drafted storm plan, measured roofs with proposals (a draft, two sent, one signed), a
 * Front Desk number with texts and calls, Agents history with minutes saved, an open insurance claim,
 * appointments on the calendar, and Follow-up and Scheduler plans waiting for a yes.
 *
 * Every name, address, email (.test) and phone number (555) is invented. All dates are relative to
 * `now`, so the world always looks fresh. Running it again changes nothing: when a company with the
 * slug exists it returns `created: false`.
 */

export const DEMO_COMPANY_SLUG = 'summit-ridge-roofing';
/** The demo's instant quote page: /q/summit-ridge. */
export const DEMO_QUOTE_SLUG = 'summit-ridge';
export const DEMO_COMPANY_NAME = 'Summit Ridge Roofing';
/** A fictional, demo-only credential (every demo user shares the password). */
export const DEMO_LOGIN = { email: 'owner@summitridge.test', password: 'summit-ridge-demo' } as const;

export type DemoWorld = { created: boolean; companyId: string; counts: Record<string, number> };

export type DemoWorldOptions = {
  /** ENCRYPTION_KEY of the API that will serve the world: proposal links are minted with it. Without it the proposals keep unminted links. */
  encryptionKey?: string;
  /**
   * The object store the API serving the world reads (DEMO_FILES_DIR in demo mode). Given with
   * `encryptionKey`, the signed proposal's PDF is rendered into it now, so it opens straight away;
   * without it the PDF waits for the worker's signed-pdf sweep.
   */
  objectStore?: ObjectStore;
};

/** The demo company's people. The owner signs in with DEMO_LOGIN. */
export const DEMO_USERS = [
  { email: DEMO_LOGIN.email, name: 'Dana Whitfield', role: 'owner', canApproveSpend: true },
  { email: 'office@summitridge.test', name: 'Leah Torres', role: 'office', canApproveSpend: false },
  { email: 'jordan@summitridge.test', name: 'Jordan Ellis', role: 'rep' },
  { email: 'casey@summitridge.test', name: 'Casey Moreno', role: 'rep' },
] as const;

const COMPANY_PHONE = '+14025550180';
/** The company's Roofline (Front Desk) number. */
export const DEMO_ROOFLINE_NUMBER = '+14025550181';
/** What Front Desk knows about the demo company; plain facts it answers from. */
const DEMO_FRONT_DESK_FACTS =
  'Free roof inspections, usually within two days. We work with all major insurance companies and can meet the adjuster. Office hours: Mon-Fri 8 AM-6 PM, Sat 9 AM-1 PM. Serving Omaha and nearby towns.';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type JobPick = { id: string; customerId: string; propertyId: string; firstName: string | null; displayName: string; lng: number; lat: number };

/** The company's jobs at one stage, in a stable order (by customer name). */
async function jobsAt(q: Query, companyId: string, stage: JobStage): Promise<JobPick[]> {
  const rows = await q(
    `select j.id, j.customer_id, j.property_id, c.first_name, c.display_name, ST_X(p.geom) as lng, ST_Y(p.geom) as lat
       from jobs j join customers c on c.id = j.customer_id join properties p on p.id = j.property_id
      where j.company_id = $1 and j.stage = $2 and j.archived_at is null
      order by c.display_name, j.id`,
    [companyId, stage],
  );
  return rows.map((r) => ({
    id: r.id as string,
    customerId: r.customer_id as string,
    propertyId: r.property_id as string,
    firstName: (r.first_name as string | null) ?? null,
    displayName: r.display_name as string,
    lng: Number(r.lng),
    lat: Number(r.lat),
  }));
}

/** Gives a customer a (fictional) mobile number and text consent, unless it already has a number. */
async function givePhone(q: Query, customerId: string, e164: string): Promise<void> {
  await q(
    `update customers set phones = jsonb_build_array(jsonb_build_object('e164', $2::text, 'label', 'mobile', 'primary', true)),
            sms_consent_status = 'attested'
      where id = $1 and jsonb_array_length(phones) = 0`,
    [customerId, e164],
  );
}

/** The distance within which neighbouring buildings are listed beside the house, as the live measure does. */
const NEIGHBOUR_SEARCH_M = 40;

/** Measures the job's real building (the outline the demo loaded under its home) and drafts a proposal from it; returns the proposal id. */
async function measureAndDraft(tx: Tx, ctx: TenantContext, job: JobPick, pitchX12: number, at: Date): Promise<string> {
  const rows = await footprintsNear(tx, [job.lng, job.lat], NEIGHBOUR_SEARCH_M);
  const main = rows.find((r) => r.contains);
  if (main === undefined) throw new Error(`The demo home ${job.displayName} is not on a building outline.`);
  const outline: Outline = [main.ring];
  const estimate = instantEstimate({ outline, pitchX12, overhangFt: 1, valleyFt: 18 });
  const measurement = await createMeasurement(
    tx,
    ctx,
    {
      propertyId: job.propertyId,
      jobId: job.id,
      kind: 'estimate',
      method: 'outline',
      outline,
      structures: rows.map((r) => ({ footprintId: r.id, included: r.id === main.id, areaSqFt: r.areaSqFt, ring: r.ring })),
      estimate,
      overhangFt: 1,
      center: [job.lng, job.lat],
    },
    at,
  );
  await setPropertyFootprint(tx, ctx, job.propertyId, main.id);
  const basics = await getMeasurementBasics(tx, ctx, measurement.id);
  if (!basics) throw new Error('The demo measurement was not found after saving.');
  const options = await priceOptions(tx, ctx, basics);
  const validUntil = await validUntilFor(tx, ctx, at);
  const proposal = await createProposal(
    tx,
    ctx,
    { jobId: job.id, customerId: job.customerId, propertyId: job.propertyId, measurementId: basics.id, basis: basics.kind, validUntil, messageBody: DEFAULT_PROPOSAL_MESSAGE, options },
    at,
  );
  await noteDrafted(tx, ctx, job.id, `Proposal ${proposal.number} drafted`, at);
  return proposal.id;
}

/** Mints the homeowner link the way the send step does (32 random bytes; hash and encrypted token stored). */
async function mintLink(tx: Tx, ctx: TenantContext, proposalId: string, encryptionKey: string | undefined): Promise<void> {
  if (encryptionKey === undefined) return;
  const token = randomBytes(32).toString('base64url');
  await mintProposalLink(tx, ctx, proposalId, createHash('sha256').update(token).digest(), encrypt(token, encryptionKey));
}

/** Marks a proposal texted at `at` (the send step's settle), with its link minted. */
async function markSent(tx: Tx, ctx: TenantContext, proposalId: string, at: Date, encryptionKey: string | undefined): Promise<void> {
  await mintLink(tx, ctx, proposalId, encryptionKey);
  await settleSentProposal(tx, ctx, proposalId, at);
}

/** Signs a sent proposal on the homeowner's behalf, as the public sign route does (typed signature, no drawing). */
async function signAs(tx: Tx, ctx: TenantContext, proposalId: string, signer: string, at: Date): Promise<void> {
  const view = await publicProposalView(tx, ctx, proposalId, at);
  const option = view.options.find((o) => o.tier === 'better') ?? view.options[0];
  if (!option) throw new Error('The demo proposal has no option to sign.');
  const document = signedDocument(view, option.id, view.estimateClause);
  const outcome = await signProposal(
    tx,
    ctx,
    proposalId,
    {
      optionId: option.id,
      signerName: signer,
      typedSignature: signer,
      drawnSignaturePngSha256: null,
      consentText: CONSENT_TEXT_V1,
      consentVersion: 'v1',
      documentSha256: createHash('sha256').update(canonicalJson(document)).digest('hex'),
      totalCents: option.totalCents,
      ip: '192.0.2.10',
      userAgent: 'Demo seed',
      signedAt: at.toISOString(),
      viewedFirstAt: null,
      ipHash: createHash('sha256').update(`demo:${proposalId}`).digest('hex'),
    },
    at,
  );
  if (outcome !== 'signed') throw new Error(`The demo proposal could not be signed (${outcome}).`);
  await recordSignedDocument(tx, ctx, proposalId, document);
}

/* ------------------------------------------------------------------------------------------------ */
/* Front Desk                                                                                         */

type TurnSeed = { speaker: 'caller' | 'assistant' | 'team'; text: string; toolCalls?: ToolCallRecord[] };

const FRONT_DESK_PEOPLE = {
  gloria: { name: 'Gloria Hendricks', phone: '+14025550321', address: '4418 Walnut Hill Dr' },
  walter: { name: 'Walter Kim', phone: '+14025550322', address: '2210 Cottonwood Ln' },
  rosa: { name: 'Rosa Delgado', phone: '+14025550323', address: '7735 Prairie View Ct' },
  ben: { name: 'Ben Avery', phone: '+14025550324', address: '1609 Larkspur Ave' },
  leak: { phone: '+14025550325' },
} as const;

/** Writes the Front Desk threads; returns the customer and home of the caller who booked an inspection. */
async function seedFrontDeskWorld(pools: Pools, ctx: TenantContext, now: Date, companyName: string, homes: readonly LngLat[]): Promise<{ customerId: string; propertyId: string }> {
  const { companyId } = ctx;
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE);

  return withTenant(pools, ctx, async (tx) => {
    const homeIds = new Map<string, string>();
    const customer = async (p: { name: string; phone: string; address: string }, lngLat: LngLat): Promise<string> => {
      const [first, ...rest] = p.name.split(' ');
      const row = await createCustomer(
        tx,
        ctx,
        { displayName: p.name, firstName: first ?? p.name, lastName: rest.join(' ') || null, phones: [{ e164: p.phone, label: 'mobile', primary: true }], smsConsentStatus: 'express' },
        { now: at(60 * 24 * 2) },
      );
      const home = await createProperty(tx, ctx, { customerId: row.id, addressLine: p.address, city: 'Omaha', state: 'NE', zip: '68134', location: lngLat }, { now: at(60 * 24 * 2) });
      homeIds.set(row.id, home.id);
      return row.id;
    };

    const conversation = async (o: {
      channel: 'voice' | 'sms';
      phone: string;
      customerId?: string | null;
      outcome?: 'booked' | 'message' | 'spam' | null;
      unread?: number;
      summary?: string | null;
      minutesAgo: number;
      identity?: 'unknown' | 'matched' | 'verified';
    }): Promise<string> => {
      const [row] = await tx
        .insert(conversations)
        .values({
          companyId,
          channel: o.channel,
          customerId: o.customerId ?? null,
          phoneE164: o.phone,
          companyNumberE164: DEMO_ROOFLINE_NUMBER,
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
      // Front Desk picks up in 0.6-1.2 seconds, so the answer-time tile reads like a real line.
      const pickupMs = 600 + ((aiSeconds * 37) % 7) * 100;
      const [row] = await tx
        .insert(calls)
        .values({
          companyId,
          conversationId,
          callSid: `CA${randomUUID().replace(/-/g, '')}`,
          fromE164: from,
          toE164: DEMO_ROOFLINE_NUMBER,
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

    const p = FRONT_DESK_PEOPLE;
    const gloriaId = await customer(p.gloria, homes[0]!);
    const walterId = await customer(p.walter, homes[1]!);
    const rosaId = await customer(p.rosa, homes[2]!);
    const benId = await customer(p.ben, homes[3]!);

    // Call 1: a booked inspection.
    const gloria = await conversation({
      channel: 'voice',
      phone: p.gloria.phone,
      customerId: gloriaId,
      outcome: 'booked',
      unread: 1,
      summary: 'Gloria found shingle pieces in her yard after the hail and booked a free inspection for Thursday at 10:00 AM.',
      identity: 'matched',
      minutesAgo: 34,
    });
    const gloriaCall = await call(gloria, p.gloria.phone, 37, 142);
    await turns(
      gloria,
      gloriaCall,
      [
        { speaker: 'assistant', text: `Thanks for calling ${companyName}. I'm the virtual assistant, and this call is recorded. How can I help?` },
        { speaker: 'caller', text: 'Hi, after the hail the other night I found pieces of shingle all over my yard.' },
        { speaker: 'assistant', text: 'I am sorry to hear that. Is this for the home on Walnut Hill Drive?' },
        { speaker: 'caller', text: 'Yes, that is the one.' },
        { speaker: 'assistant', text: 'We can send an inspector to check the roof for free. Thursday at 10:00 AM or Friday at 2:00 PM, which works better?' },
        { speaker: 'caller', text: 'Thursday morning is great.' },
        {
          speaker: 'assistant',
          text: 'You are booked for Thursday at 10:00 AM. You will get a text to confirm, and Jordan from our team will be your inspector.',
          toolCalls: [{ name: 'book_inspection', input: { day: 'Thursday', time: '10:00' }, result: 'Booked', ok: true }],
        },
        { speaker: 'caller', text: 'Perfect, thank you.' },
      ],
      37,
    );

    // Call 2: an urgent leak message from someone not yet a customer.
    const leak = await conversation({
      channel: 'voice',
      phone: p.leak.phone,
      outcome: 'message',
      unread: 1,
      summary: 'A new caller has water coming through the kitchen ceiling after the storm and asked for a call back today.',
      minutesAgo: 75,
    });
    const leakCall = await call(leak, p.leak.phone, 78, 96);
    await turns(
      leak,
      leakCall,
      [
        { speaker: 'assistant', text: `Thanks for calling ${companyName}. I'm the virtual assistant, and this call is recorded. How can I help?` },
        { speaker: 'caller', text: 'Water is dripping through my kitchen ceiling since the storm. Can someone call me back today?' },
        { speaker: 'assistant', text: 'I am marking this urgent. Can I get your name and the address?' },
        { speaker: 'caller', text: 'It is Harold, at 3125 Juniper Ridge Rd.' },
        {
          speaker: 'assistant',
          text: 'Thank you, Harold. I have taken your message and marked it urgent. Someone from our team will call you back shortly.',
          toolCalls: [{ name: 'take_message', input: { urgent: true }, result: 'Taken', ok: true }],
        },
      ],
      78,
    );

    // Text threads.
    const walter = await conversation({ channel: 'sms', phone: p.walter.phone, customerId: walterId, unread: 2, identity: 'matched', minutesAgo: 6 });
    await turns(
      walter,
      null,
      [
        { speaker: 'caller', text: 'Hi, did the hail on Sunday hit Cottonwood Lane? A neighbor said you are checking roofs.' },
        { speaker: 'caller', text: 'I can be home any afternoon this week.' },
      ],
      8,
      2,
    );

    const rosa = await conversation({
      channel: 'sms',
      phone: p.rosa.phone,
      customerId: rosaId,
      outcome: 'booked',
      summary: 'Rosa asked about financing and booked a Saturday inspection.',
      identity: 'matched',
      minutesAgo: 190,
    });
    await turns(
      rosa,
      null,
      [
        { speaker: 'caller', text: 'Do you offer financing for a new roof?' },
        { speaker: 'assistant', text: 'We do. Monthly payment options are shown on every proposal. Would you like a free inspection first?' },
        { speaker: 'caller', text: 'Yes please, Saturday morning if possible.' },
        {
          speaker: 'assistant',
          text: 'You are booked for Saturday at 9:00 AM. Reply here if anything changes.',
          toolCalls: [{ name: 'book_inspection', input: { day: 'Saturday', time: '09:00' }, result: 'Booked', ok: true }],
        },
        { speaker: 'caller', text: 'Thank you!' },
      ],
      200,
      2,
    );

    const ben = await conversation({ channel: 'sms', phone: p.ben.phone, customerId: benId, unread: 1, identity: 'matched', minutesAgo: 22 });
    await turns(
      ben,
      null,
      [
        { speaker: 'team', text: `Hi Ben, it's ${companyName}. Sunday's hail passed over Larkspur Ave. Want a free roof check this week?` },
        { speaker: 'caller', text: 'Yes. Also my gutter on the north side got dented, can you look at that too?' },
      ],
      30,
      8,
    );
    return { customerId: gloriaId, propertyId: homeIds.get(gloriaId)! };
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* Agents history (minutes saved), ported from the e2e agents seed                                    */

type StepSeed = { type: string; baseline: string; units: number; perUnit: number; minutes: number; result?: Record<string, number> };

async function seedAgentsHistory(q: Query, companyId: string, ownerId: string, now: Date): Promise<void> {
  const tz = ((await q(`select timezone from companies where id = $1`, [companyId]))[0]?.timezone as string | undefined) ?? 'America/Chicago';
  const noonDaysAgo = async (days: number): Promise<Date> => {
    const r = await q(
      `select least((((($1::timestamptz at time zone $2)::date - $3::int) + time '12:00') at time zone $2), $1::timestamptz) as t`,
      [now, tz, days],
    );
    return new Date(r[0]!.t as Date);
  };
  const today = await q(
    `select least(greatest((($1::timestamptz at time zone $2)::date::timestamp at time zone $2) + interval '1 minute',
                          $1::timestamptz - interval '10 minutes'), $1::timestamptz) as t`,
    [now, tz],
  );
  const finishedToday = new Date(today[0]!.t as Date);
  const before = (d: Date, m: number) => new Date(d.getTime() - m * MINUTE);
  let seq = 0;
  const tag = `demo-${randomUUID()}`;

  const insertTask = async (a: { agent: string; kind: string; title: string; status: string; at: Date; minutes?: number; approved?: boolean; expiresAt?: Date }): Promise<string> => {
    const r = await q(
      `insert into agent_tasks (company_id, agent, kind, title, mode, status, expires_at, minutes_saved, approved_by_user_id, approved_at, created_at, updated_at)
       values ($1,$2,$3,$4,'needs_approval',$5,$6,$7,$8,$9,$10,$10) returning id`,
      [companyId, a.agent, a.kind, a.title, a.status, a.expiresAt ?? null, a.minutes ?? null, a.approved ? ownerId : null, a.approved ? before(a.at, 5) : null, a.at],
    );
    return r[0]!.id as string;
  };
  const insertStep = async (taskId: string, position: number, at: Date, s: { type: string; approvalClass: string; status: string; step?: StepSeed; error?: string }): Promise<string> => {
    seq += 1;
    const r = await q(
      `insert into agent_task_steps (company_id, task_id, position, type, approval_class, status, payload, preview, idempotency_key, error_plain,
                                     baseline_key, units, minutes_per_unit, minutes_saved, result, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,'{}'::jsonb,'{}'::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$14) returning id`,
      [
        companyId, taskId, position, s.type, s.approvalClass, s.status, `${tag}-${seq}`, s.error ?? null,
        s.step?.baseline ?? null, s.step?.units ?? null, s.step?.perUnit ?? null, s.step?.minutes ?? null,
        s.step?.result ? JSON.stringify(s.step.result) : null, at,
      ],
    );
    return r[0]!.id as string;
  };
  const insertEvent = async (taskId: string, stepId: string | null, kind: string, actor: 'agent' | 'system' | 'user', at: Date, data: Record<string, unknown> = {}) => {
    await q(
      `insert into agent_task_events (company_id, task_id, step_id, kind, actor_type, actor_user_id, data, at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [companyId, taskId, stepId, kind, actor, actor === 'user' ? ownerId : null, JSON.stringify(data), at],
    );
  };
  const doneTask = async (a: { agent: string; kind: string; title: string; finished: Date; approvalClass: string; steps: StepSeed[]; approvedEvent?: boolean }) => {
    const total = a.steps.reduce((sum, s) => sum + s.minutes, 0);
    const created = before(a.finished, 30);
    const taskId = await insertTask({ agent: a.agent, kind: a.kind, title: a.title, status: 'done', at: a.finished, minutes: total, approved: true });
    await q(`update agent_tasks set created_at = $2 where id = $1`, [taskId, created]);
    await insertEvent(taskId, null, 'created', 'agent', created);
    // The counts a real approval writes, so the feed says "approved 1 step" and not "approved the plan with every step switched off"
    if (a.approvedEvent) {
      await insertEvent(taskId, null, 'approved', 'user', before(a.finished, 5), { totalSteps: a.steps.length, approvedSteps: a.steps.length, forwardedSteps: 0 });
    }
    for (const [i, step] of a.steps.entries()) {
      const stepId = await insertStep(taskId, i + 1, a.finished, { type: step.type, approvalClass: a.approvalClass, status: 'done', step });
      await insertEvent(taskId, stepId, 'step_done', 'agent', before(a.finished, 1), { units: step.units });
    }
    await insertEvent(taskId, null, 'finished', 'system', a.finished, { steps: a.steps.length });
  };

  const proposal: StepSeed = { type: 'send_proposal', baseline: 'proposal_sent', units: 1, perUnit: 20, minutes: 20 };
  await doneTask({
    agent: 'storm_scout', kind: 'storm_plan', title: 'Storm plan for Elkhorn', finished: finishedToday, approvalClass: 'message', approvedEvent: true,
    steps: [{ type: 'send_sms_batch', baseline: 'text_sent', units: 48, perUnit: 1.5, minutes: 72, result: { sent: 48 } }],
  });
  await doneTask({
    agent: 'storm_scout', kind: 'storm_plan', title: 'Storm plan for Millard', finished: await noonDaysAgo(5), approvalClass: 'message',
    steps: [
      { type: 'send_email_batch', baseline: 'email_sent', units: 180, perUnit: 0.5, minutes: 90, result: { sent: 180 } },
      { type: 'build_routes', baseline: 'route_built', units: 2, perUnit: 45, minutes: 90, result: { routes: 2 } },
    ],
  });
  await doneTask({
    agent: 'storm_scout', kind: 'storm_plan', title: 'Storm plan for Papillion', finished: await noonDaysAgo(12), approvalClass: 'message',
    steps: [{ type: 'send_sms_batch', baseline: 'text_sent', units: 64, perUnit: 1.5, minutes: 96, result: { sent: 64 } }],
  });
  await doneTask({ agent: 'estimator', kind: 'proposal_send', title: 'Proposal for Lindqvist', finished: await noonDaysAgo(1), approvalClass: 'message', steps: [proposal] });
  await doneTask({
    agent: 'estimator', kind: 'proposal_send', title: 'Proposal for Okonkwo', finished: await noonDaysAgo(3), approvalClass: 'message',
    steps: [proposal, { type: 'order_exact_report', baseline: 'exact_report', units: 1, perUnit: 10, minutes: 10 }],
  });
  await doneTask({ agent: 'estimator', kind: 'proposal_send', title: 'Proposal for Brandt', finished: await noonDaysAgo(8), approvalClass: 'message', steps: [proposal] });

  // One plan the agent could not finish.
  const attentionAt = before(now, 150);
  const attention = await insertTask({ agent: 'storm_scout', kind: 'storm_plan', title: 'Storm plan for Bellevue', status: 'needs_attention', at: attentionAt, approved: true });
  await insertEvent(attention, null, 'created', 'agent', before(attentionAt, 30));
  const step = await insertStep(attention, 1, attentionAt, { type: 'send_sms_batch', approvalClass: 'message', status: 'needs_attention', error: 'The texting service could not reach 3 numbers.' });
  await insertEvent(attention, step, 'step_attention', 'agent', attentionAt);
}

/* ------------------------------------------------------------------------------------------------ */
/* Agents dashboard activity: finished work for all six agents (tiles, hourly trend, handoffs)      */

type DashSpec = {
  kind: string;
  stepType: string;
  baseline: string;
  units: number;
  perUnit: number;
  title: (where: string) => string;
};

/** What each agent finishes in the demo: a plain-sentence title (the feed shows it), one done step and its snapshot. */
const DASH_SPECS: Record<string, DashSpec> = {
  storm_scout: { kind: 'storm_plan', stepType: 'send_sms_batch', baseline: 'text_sent', units: 24, perUnit: 1.5, title: (w) => `Scored ${w} in last night's hail path` },
  front_desk: { kind: 'call', stepType: 'send_sms_batch', baseline: 'booking', units: 1, perUnit: 3, title: (w) => `Booked an inspection at ${w}` },
  estimator: { kind: 'send_proposal', stepType: 'send_proposal', baseline: 'proposal_sent', units: 1, perUnit: 20, title: (w) => `Sent a proposal for ${w}` },
  claims: { kind: 'claim_packet', stepType: 'send_email_batch', baseline: 'claim_packet', units: 1, perUnit: 30, title: (w) => `Built a claim packet for ${w}` },
  scheduler: { kind: 'weather_moves', stepType: 'send_sms_batch', baseline: 'install_moved', units: 1, perUnit: 10, title: (w) => `Flagged ${w} for a rain day` },
  follow_up: { kind: 'follow_ups', stepType: 'send_sms_batch', baseline: 'follow_up_sent', units: 6, perUnit: 2, title: (w) => `Sent follow-up texts near ${w}` },
};
const DASH_AGENTS = ['front_desk', 'storm_scout', 'estimator', 'follow_up', 'claims', 'scheduler'] as const;
/** Finished tasks per hour for the last 12 hours, oldest first: a quiet night, a busy morning. */
const DASH_HOURLY = [1, 1, 2, 3, 5, 6, 5, 4, 3, 4, 5, 6] as const;

export async function seedAgentsDashboardActivity(q: Query, companyId: string, now: Date): Promise<void> {
  const where = await q(
    `select j.id, p.address_line from jobs j join properties p on p.company_id = j.company_id and p.id = j.property_id
      where j.company_id = $1 and j.archived_at is null order by j.created_at, j.id limit 12`,
    [companyId],
  );
  const places = where.map((r) => ({ id: r.id as string, address: String(r.address_line) }));
  if (places.length === 0) return;
  const tag = `dash-${randomUUID()}`;
  let seq = 0;

  const finishedTask = async (agent: string, at: Date, place: { id: string; address: string }, subject: boolean, created = at): Promise<void> => {
    const spec = DASH_SPECS[agent]!;
    const minutes = spec.units * spec.perUnit;
    const task = await q(
      `insert into agent_tasks (company_id, agent, kind, title, mode, status, minutes_saved, subject_type, subject_id, created_at, updated_at)
       values ($1,$2,$3,$4,'live','done',$5,$6,$7,$8,$9) returning id`,
      [companyId, agent, spec.kind, spec.title(place.address), minutes, subject ? 'job' : null, subject ? place.id : null, created, at],
    );
    const taskId = task[0]!.id as string;
    seq += 1;
    await q(
      `insert into agent_task_steps (company_id, task_id, position, type, approval_class, status, payload, preview, idempotency_key,
                                     baseline_key, units, minutes_per_unit, minutes_saved, result, created_at, updated_at)
       values ($1,$2,1,$3,'internal','done','{}'::jsonb,jsonb_build_object('title', $10::text, 'lines', '[]'::jsonb),$4,$5,$6,$7,$8,'{}'::jsonb,$9,$9)`,
      // A review shows the step's preview ({ title, lines }); an empty object would break it.
      [companyId, taskId, spec.stepType, `${tag}-${seq}`, spec.baseline, spec.units, spec.perUnit, minutes, at, spec.title(place.address)],
    );
    await q(
      `insert into agent_task_events (company_id, task_id, step_id, kind, actor_type, actor_user_id, data, at)
       values ($1,$2,null,'finished','agent',null,'{"steps":1}'::jsonb,$3)`,
      [companyId, taskId, at],
    );
  };

  // The last 12 hours, spread over the six agents.
  let n = 0;
  for (let ago = DASH_HOURLY.length - 1; ago >= 0; ago -= 1) {
    const count = DASH_HOURLY[DASH_HOURLY.length - 1 - ago]!;
    for (let k = 0; k < count; k += 1) {
      const minutesBack = ago * 60 + 3 + ((k * 11 + n * 7) % 50);
      const place = places[n % places.length]!;
      await finishedTask(DASH_AGENTS[n % DASH_AGENTS.length]!, new Date(now.getTime() - minutesBack * MINUTE), place, false);
      n += 1;
    }
  }

  // Real handoffs: four jobs passed from one agent to the next today (each task starts after the last one).
  const chains: string[][] = [
    ['storm_scout', 'front_desk', 'estimator'],
    ['front_desk', 'estimator', 'claims'],
    ['storm_scout', 'front_desk', 'scheduler'],
    ['estimator', 'follow_up'],
  ];
  for (const [c, chain] of chains.entries()) {
    const place = places[c % places.length]!;
    for (const [i, agent] of chain.entries()) {
      const startedBack = (chain.length - i) * 55 + c * 20;
      const created = new Date(now.getTime() - startedBack * MINUTE);
      await finishedTask(agent, new Date(created.getTime() + 20 * MINUTE), place, true, created);
    }
  }

  // The 13 days before today, so every card's 14-day trend and the week's hours have a shape.
  for (let day = 1; day <= 13; day += 1) {
    for (const [i, agent] of DASH_AGENTS.entries()) {
      const count = 1 + ((day + i) % 3);
      for (let k = 0; k < count; k += 1) {
        const at = new Date(now.getTime() - day * DAY - (k * 95 + i * 17) * MINUTE);
        await finishedTask(agent, at, places[(day + i + k) % places.length]!, false);
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------------ */

/** Counts of what the world holds, for the summary and the tests. */
export async function demoWorldCounts(q: Query, companyId: string): Promise<Record<string, number>> {
  const one = async (sql: string): Promise<number> => Number((await q(sql, [companyId]))[0]?.n ?? 0);
  const counts: Record<string, number> = {
    customers: await one(`select count(*) as n from customers where company_id = $1`),
    properties: await one(`select count(*) as n from properties where company_id = $1`),
    jobs: await one(`select count(*) as n from jobs where company_id = $1`),
    measurements: await one(`select count(*) as n from measurements where company_id = $1`),
    proposals: await one(`select count(*) as n from proposals where company_id = $1`),
    stormHits: await one(`select count(*) as n from storm_hits where company_id = $1`),
    companyStorms: await one(`select count(*) as n from company_storms where company_id = $1`),
    conversations: await one(`select count(*) as n from conversations where company_id = $1`),
    calls: await one(`select count(*) as n from calls where company_id = $1`),
    turns: await one(`select count(*) as n from conversation_turns where company_id = $1`),
    agentTasks: await one(`select count(*) as n from agent_tasks where company_id = $1`),
    minutesSaved: await one(`select coalesce(sum(minutes_saved), 0) as n from agent_tasks where company_id = $1`),
    appointments: await one(`select count(*) as n from appointments where company_id = $1`),
    claims: await one(`select count(*) as n from claims where company_id = $1`),
    members: await one(`select count(*) as n from memberships where company_id = $1`),
  };
  for (const r of await q(`select stage, count(*) as n from jobs where company_id = $1 group by stage`, [companyId])) counts[`jobs.${String(r.stage)}`] = Number(r.n);
  for (const r of await q(`select status, count(*) as n from proposals where company_id = $1 group by status`, [companyId])) counts[`proposals.${String(r.status)}`] = Number(r.n);
  for (const r of await q(`select status, count(*) as n from agent_tasks where company_id = $1 group by status`, [companyId])) counts[`agentTasks.${String(r.status)}`] = Number(r.n);
  return counts;
}

/**
 * Makes the demo world when no company has DEMO_COMPANY_SLUG; otherwise changes nothing and returns
 * `created: false` with the existing company's counts. `ownerUrl` connects as the table owner (the
 * company, its users, and the global storm and footprint rows are written with it).
 */
export async function seedDemoWorld(pools: Pools, ownerUrl: string, now: Date, opts: DemoWorldOptions = {}): Promise<DemoWorld> {
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  const q: Query = async (text, values) => (await owner.query(text, values)).rows as Record<string, unknown>[];
  try {
    const existing = await findCompanyBySlug(pools.system, DEMO_COMPANY_SLUG);
    if (existing) return { created: false, companyId: existing.id, counts: await demoWorldCounts(q, existing.id) };

    const company = await seedCompany(ownerUrl, {
      name: DEMO_COMPANY_NAME,
      slug: DEMO_COMPANY_SLUG,
      timezone: 'America/Chicago',
      state: 'NE',
      phoneE164: COMPANY_PHONE,
      users: DEMO_USERS.map((u) => ({ ...u })),
      password: DEMO_LOGIN.password,
    });
    const { companyId } = company;
    const ctx = systemContext(companyId);
    const userId = (email: string) => company.users.find((u) => u.email === email)!.userId;
    const ownerId = userId(DEMO_LOGIN.email);
    const jordanId = userId('jordan@summitridge.test');
    const caseyId = userId('casey@summitridge.test');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const ahead = (ms: number) => new Date(now.getTime() + ms);

    // Every home sits on a real Omaha building (demo/places.ts), so Measure over real aerial imagery shows the real roof
    // with a matching outline. The six homes added after the storm (front desk and old leads) take theirs first; the
    // showcase addresses then take a building under the same hail as their old spot, so the storm still hits the same 37.
    const placer = new DemoPlacer();
    const placeAt = (b: { pt: readonly [number, number] }): LngLat => [b.pt[0], b.pt[1]];
    const extraHomes = Array.from({ length: 6 }, () => placeAt(placer.take(0)));
    const frontDeskHomes = extraHomes.slice(0, 4);
    const leadHomes = extraHomes.slice(4);

    // 1. The CRM book: 60 customers, 70 addresses, 28 jobs in every stage, and a sample storm plan.
    await seedShowcase(pools, companyId, now, {
      companyName: DEMO_COMPANY_NAME,
      relocate: (old) => placeAt(placer.take(hailOver(old, OMAHA_CONTOURS))),
    });
    // Half the worked jobs go to the second rep, so the board shows two people.
    await q(
      `update jobs set assigned_user_id = $2
        where id in (select id from (select id, row_number() over (order by id) as n from jobs
                                      where company_id = $1 and assigned_user_id is not null) t where n % 2 = 0)`,
      [companyId, caseyId],
    );

    // 2. Yesterday's hail storm over the book, the homes it hit, and a drafted storm plan.
    // The building outlines are the real ones from the asset (filed in their Omaha footprint tile, marked ready), not the e2e fixture's rectangles.
    await seedFootprintFixture(pools, placer.footprints());
    const { companyStormId } = await seedStormFixture(pools, companyId, { now, query: q, footprints: false });
    await q(`update storms set place_name = 'West Omaha, NE' where id = (select storm_id from company_storms where id = $1)`, [companyStormId]);
    await q(`update company_storms set created_at = $2 where id = $1`, [companyStormId, ago(14 * HOUR)]);
    await q(`update ad_accounts set name = $2 where company_id = $1 and platform = 'google'`, [companyId, 'Summit Ridge Google Ads']);
    await q(`update ad_accounts set name = $2 where company_id = $1 and platform = 'meta'`, [companyId, 'Summit Ridge Facebook Ads']);
    // Drafting only reads the pools; the "plan is ready" email goes to a mailer that keeps nothing.
    const quietDeps = {
      pools,
      config: { APP_ORIGIN: 'http://localhost:5173' },
      mailer: { send: async () => undefined },
    } as unknown as AppDeps;
    await draftStormPlan(quietDeps, companyId, companyStormId, now);

    // 3. Measured roofs and proposals: two sent (one viewed), one signed, one draft.
    const proposalJobs = await jobsAt(q, companyId, 'proposal');
    const inspectionJobs = await jobsAt(q, companyId, 'inspection');
    const [sentA, sentB, signedJob] = proposalJobs;
    const draftJob = inspectionJobs[0];
    if (!sentA || !sentB || !signedJob || !draftJob) throw new Error('The showcase did not make enough proposal and inspection jobs.');
    for (const [i, job] of [sentA, sentB, signedJob, draftJob].entries()) await givePhone(q, job.customerId, `+1402555030${i + 1}`);
    let signedProposalId: string | undefined;
    await withTenant(pools, ctx, async (tx) => {
      const a = await measureAndDraft(tx, ctx, sentA, 6, ago(3 * DAY));
      await markSent(tx, ctx, a, ago(3 * DAY + 2 * HOUR), opts.encryptionKey);
      await tx.execute(
        // The homeowner opened it twice.
        sql`update proposals set status = 'viewed', view_count = 2, first_viewed_at = ${ago(2 * DAY)}, last_viewed_at = ${ago(5 * HOUR)} where id = ${a}`,
      );
      await addProposalEvent(tx, ctx, { proposalId: a, kind: 'viewed', at: ago(2 * DAY) });
      await addProposalEvent(tx, ctx, { proposalId: a, kind: 'viewed', at: ago(5 * HOUR) });

      const b = await measureAndDraft(tx, ctx, sentB, 7, ago(DAY + 3 * HOUR));
      await markSent(tx, ctx, b, ago(DAY), opts.encryptionKey);

      const s = await measureAndDraft(tx, ctx, signedJob, 5, ago(6 * DAY));
      await markSent(tx, ctx, s, ago(6 * DAY - HOUR), opts.encryptionKey);
      await signAs(tx, ctx, s, signedJob.displayName, ago(4 * DAY));
      signedProposalId = s;

      await measureAndDraft(tx, ctx, draftJob, 8, ago(2 * HOUR));
    });
    // The signed copy, rendered as the signed-pdf job would (its email to the homeowner goes nowhere).
    if (signedProposalId && opts.objectStore && opts.encryptionKey) {
      await makeSignedPdf(
        {
          pools,
          objectStore: opts.objectStore,
          clock: systemClock,
          mailer: { send: async () => undefined },
          config: { ENCRYPTION_KEY: opts.encryptionKey, PROPOSAL_LINK_BASE_URL: 'http://localhost' },
        },
        companyId,
        signedProposalId,
        { attempt: 1, lastAttempt: true },
      );
    }

    // 4. Front Desk: the Roofline number, two calls with transcripts, three text threads.
    await q(
      `insert into company_phone_numbers (company_id, e164, capabilities, provider_sid) values ($1, $2, array['sms','voice'], 'PN_demo_summit_ridge')`,
      [companyId, DEMO_ROOFLINE_NUMBER],
    );
    // Front Desk is on: answering calls and texts, forwarding checked, with a few facts to answer from.
    await q(
      `update company_settings set front_desk_enabled = true, front_desk_texts = true, forwarding_verified_at = $2, front_desk_facts = $3 where company_id = $1`,
      [companyId, ago(3 * DAY), DEMO_FRONT_DESK_FACTS],
    );
    const booked = await seedFrontDeskWorld(pools, ctx, now, DEMO_COMPANY_NAME, frontDeskHomes);

    // The instant quote page, /q/summit-ridge: on, all three services, visit times offered, the default range and cap.
    await q(
      `update company_settings set quote_enabled = true, quote_slug = $2, quote_products = '{windows,roof,gutters}', quote_booking = true where company_id = $1`,
      [companyId, DEMO_QUOTE_SLUG],
    );

    // 5. Agents history: finished plans with minutes saved, one needing attention.
    await seedAgentsHistory(q, companyId, ownerId, now);

    // 6-8. Calendar, an open claim, and Follow-up and Scheduler plans waiting for a yes.
    const wonJobs = await jobsAt(q, companyId, 'won');
    const inspectionsLeft = inspectionJobs.slice(1);
    const zoneDays = await q(`select (($1::timestamptz at time zone 'America/Chicago')::date)::text as today`, [now]);
    const today = String(zoneDays[0]!.today);
    /** `HH:MM` on the local (Chicago) day `days` from today, as an instant. */
    const localAt = async (days: number, hhmm: string): Promise<Date> => {
      const r = await q(`select (($1::date + $2::int) + $3::time) at time zone 'America/Chicago' as t`, [today, days, hhmm]);
      return new Date(r[0]!.t as Date);
    };

    await withTenant(pools, ctx, async (tx) => {
      const book = async (i: { kind: 'inspection' | 'install' | 'adjuster' | 'other'; job?: JobPick; title?: string; userId: string | null; start: Date; end: Date; notes?: string }) =>
        (
          await createAppointment(
            tx,
            ctx,
            {
              kind: i.kind,
              title: i.title ?? null,
              jobId: i.job?.id ?? null,
              customerId: i.job?.customerId ?? null,
              propertyId: i.job?.propertyId ?? null,
              assignedUserId: i.userId,
              startsAt: i.start,
              endsAt: i.end,
              allDay: false,
              notes: i.notes ?? null,
              source: 'manual',
            },
            ago(2 * DAY),
          )
        ).row;

      // Inspections across the week, split between the reps.
      const slots: [number, string, string][] = [
        [0, '10:00', '11:00'], [0, '14:00', '15:00'], [1, '09:00', '10:00'], [1, '13:30', '14:30'], [2, '11:00', '12:00'], [3, '10:00', '11:00'],
      ];
      for (const [n, job] of inspectionsLeft.slice(0, slots.length).entries()) {
        const [day, from, to] = slots[n]!;
        await book({ kind: 'inspection', job, title: `Roof inspection: ${job.displayName}`, userId: n % 2 === 0 ? jordanId : caseyId, start: await localAt(day, from), end: await localAt(day, to) });
      }
      // Installs for won jobs.
      for (const [n, job] of wonJobs.slice(0, 3).entries()) {
        await book({ kind: 'install', job, title: `Roof install: ${job.displayName}`, userId: n % 2 === 0 ? caseyId : jordanId, start: await localAt(2 + n * 2, '08:00'), end: await localAt(2 + n * 2, '16:00') });
      }
      // The inspection the Front Desk booked on Gloria's call: the coming Thursday at 10:00 AM.
      const dow = Number((await q(`select extract(isodow from $1::date) as d`, [today]))[0]!.d);
      const toThursday = ((4 - dow + 7) % 7) || 7;
      await createAppointment(
        tx,
        ctx,
        {
          kind: 'inspection',
          title: 'Roof inspection: Gloria Hendricks',
          customerId: booked.customerId,
          propertyId: booked.propertyId,
          assignedUserId: jordanId,
          startsAt: await localAt(toThursday, '10:00'),
          endsAt: await localAt(toThursday, '11:00'),
          allDay: false,
          source: 'front_desk',
        },
        ago(37 * MINUTE),
      );
      await book({ kind: 'other', title: 'Crew safety meeting', userId: ownerId, start: await localAt(1, '07:30'), end: await localAt(1, '08:15') });

      // The open insurance claim, on a won job hit by the storm, with the adjuster's visit booked.
      const claimJob = wonJobs[wonJobs.length - 1] ?? signedJob;
      const adjuster = await book({
        kind: 'adjuster',
        job: claimJob,
        title: `Adjuster visit: ${claimJob.displayName}`,
        userId: jordanId,
        start: await localAt(2, '13:00'),
        end: await localAt(2, '14:00'),
        notes: 'Meet the adjuster on site; bring the hail photos.',
      });
      await saveClaim(
        tx,
        ctx,
        claimJob.id,
        {
          insurer: 'Prairie Shield Mutual',
          claimNumber: 'PSM-2026-48213',
          dateOfLoss: new Date(now.getTime() - DAY).toISOString().slice(0, 10),
          status: 'filed',
          deductibleCents: 100_000,
          notes: 'Hail damage on the west and north slopes; gutters dented.',
        },
        { actor: 'user', userId: ownerId },
        ago(20 * HOUR),
      );
      await saveClaim(
        tx,
        ctx,
        claimJob.id,
        {
          status: 'adjuster_scheduled',
          adjusterName: 'Morgan Pryce',
          adjusterPhone: '+14025550390',
          adjusterEmail: 'mpryce@prairieshield.test',
          adjusterAppointmentId: adjuster.id,
        },
        { actor: 'user', userId: ownerId },
        ago(6 * HOUR),
      );

      // Two old leads nobody has followed up with, and the Follow-up agent's drafted texts to them.
      const oldLeads = [
        { first: 'Teresa', last: 'Vaughn', phone: '+14025550341', address: '5402 Aspen Grove Rd', lngLat: leadHomes[0]! },
        { first: 'Malik', last: 'Osei', phone: '+14025550342', address: '918 Hickory Bend Dr', lngLat: leadHomes[1]! },
      ];
      const messages: { customerId: string; jobId: string | null; body: string }[] = [];
      for (const lead of oldLeads) {
        const created = ago(10 * DAY);
        const customer = await createCustomer(
          tx,
          ctx,
          { displayName: `${lead.first} ${lead.last}`, firstName: lead.first, lastName: lead.last, phones: [{ e164: lead.phone, label: 'mobile', primary: true }], smsConsentStatus: 'express' },
          { now: created },
        );
        const property = await createProperty(tx, ctx, { customerId: customer.id, addressLine: lead.address, city: 'Omaha', state: 'NE', zip: '68144', location: lead.lngLat }, { now: created });
        const job = await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id, source: 'manual' }, { now: created });
        await addActivity(tx, ctx, { subjectType: 'job', subjectId: job.id, kind: 'note', summary: 'Asked for a quote on the website form.', at: created });
        messages.push({
          customerId: customer.id,
          jobId: null,
          body: `Hi ${lead.first}, it's ${DEMO_COMPANY_NAME}. Would Tuesday at 10 AM or Wednesday at 2 PM work for a free roof inspection?`,
        });
      }
      await createTask(
        tx,
        ctx,
        {
          agent: 'follow_up',
          kind: 'follow_ups',
          title: `Follow up with ${messages.length} leads`,
          summary: 'These leads asked for a quote over a week ago and have not heard back.',
          expiresAt: ahead(2 * DAY),
          steps: [{ type: 'send_personal_texts', payload: { purpose: 'informational', kind: 'lead', messages, dedupePrefix: 'demo:follow_ups' } }],
        },
        { now: ago(40 * MINUTE), ip: null, allowInternalStepTypes: true },
      );

      // The Scheduler's weather move: an install 3 days out, rain forecast, moved to day 6.
      const moveJob = wonJobs[wonJobs.length - 2] ?? wonJobs[0] ?? signedJob;
      const install = await book({ kind: 'install', job: moveJob, title: `Roof install: ${moveJob.displayName}`, userId: jordanId, start: await localAt(3, '10:00'), end: await localAt(3, '14:00') });
      const newStart = await localAt(6, '10:00');
      const newEnd = await localAt(6, '14:00');
      // Whose install moves, and where: the card and the review say it, so a move is never approved blind
      const [moveHome] = await q(`select address_line from properties where id = $1`, [moveJob.propertyId]);
      const whose = `${moveJob.displayName}'s install${moveHome ? ` at ${String(moveHome.address_line)}` : ''}`;
      await createTask(
        tx,
        ctx,
        {
          agent: 'scheduler',
          kind: 'weather_moves',
          title: 'Rain on the install day: move 1 install?',
          summary: `Heavy rain is forecast on the install day for ${whose}; it can move to a clear day.`,
          expiresAt: install.startsAt,
          steps: [
            {
              type: 'move_appointment',
              payload: { appointmentId: install.id, start: newStart.toISOString(), end: newEnd.toISOString(), userId: jordanId, reason: `Rain is forecast on the install day, so ${whose} moves to a clear day.` },
            },
          ],
        },
        { now: ago(25 * MINUTE), ip: null, allowInternalStepTypes: true },
      );
    });

    // 9. The Agents dashboard: finished work for all six agents (hourly trend, handoffs, week hours).
    await seedAgentsDashboardActivity(q, companyId, now);

    return { created: true, companyId, counts: await demoWorldCounts(q, companyId) };
  } finally {
    await owner.end();
  }
}
