import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  calls,
  companies,
  companyPhoneNumbers,
  conversations,
  createPools,
  decrypt,
  customers,
  type Db,
  insertCall,
  proposals,
  properties,
  publicProposalView,
  type TenantContext,
  updateCall,
  updateConversation,
  withTenant,
} from '@roofline/db';
import { insertFixtureStorm, type Query } from '@roofline/db/testing';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { runAfterCall } from '../front-desk/after-call.ts';
import { createEngine } from '../front-desk/engine.ts';
import type { ConversationState, Engine } from '../front-desk/engine-types.ts';
import { runRelayLoop } from '../front-desk/relay-session-loop.ts';
import { runFrontDeskText } from '../front-desk/texts.ts';
import { FRONT_DESK_HANDLERS } from '../front-desk/tools/index.ts';
import { handleInbound } from '../hooks/twilio.ts';
import { FakeVoiceSession } from '../providers/fakes/voice-session.ts';
import { signResolvedProposal } from '../public/proposal-sign.ts';
import { systemContext } from '../permissions.ts';
import { matchCompany } from '../storm/match.ts';
import { DEMO_CALL_LINES, DEMO_TEXTS, demoLlm } from './script.ts';

/*
 * The presenter's simulations (demo mode only, routes in demo/routes.ts). Each one makes something happen the way
 * the real outside world would, then lets the app's own code handle it: an inbound text goes through the Twilio
 * SMS hook's handler (signature checks skipped) and Front Desk answers it at once instead of after its debounce;
 * a call runs the real relay loop and engine over the in-memory FakeVoiceSession and ends with the real after-call
 * summary; a hail storm is written to the global storm tables and matched by the real storm matcher; a signature
 * goes through the public sign route's own service. Every provider in demo mode is a fake, so nothing leaves the
 * process. Front Desk answers from the demo script (demo/script.ts).
 */

export type SimulateResult = { ok: true; message: string } & Record<string, string | number | boolean | null>;

/** A fictional 555 number for a homeowner the company has never heard from. */
const STRANGER_E164 = '+14025550187';
/** The fictional numbers a company is given when it has no Roofline number yet (555-0100 to 555-0199 are fiction). */
const DEMO_NUMBER_PREFIX = '+1402555';

let textTurn = 0;

/** Front Desk's deps for a simulation: the demo script answers instead of whatever model the app holds. */
function demoDeps(deps: AppDeps): AppDeps {
  return { ...deps, llm: demoLlm() };
}

/**
 * The company's active Roofline number for Front Desk; when it has none, a fictional 555 one is added for it
 * (the system role may insert company numbers). Demo only.
 */
async function companyNumber(deps: AppDeps, companyId: string): Promise<string> {
  const ctx = systemContext(companyId);
  const existing = await withTenant(deps.pools, ctx, (tx) =>
    tx
      .select({ e164: companyPhoneNumbers.e164 })
      .from(companyPhoneNumbers)
      .where(and(eq(companyPhoneNumbers.companyId, companyId), eq(companyPhoneNumbers.status, 'active')))
      .orderBy(companyPhoneNumbers.createdAt)
      .limit(1),
  );
  if (existing[0]) return existing[0].e164;
  for (let n = 100; n <= 199; n++) {
    const e164 = `${DEMO_NUMBER_PREFIX}0${String(n)}`;
    const added = await deps.pools.system
      .insert(companyPhoneNumbers)
      .values({ companyId, e164, capabilities: ['sms', 'voice'], providerSid: `PN_demo_${String(n)}`, purpose: 'main', status: 'active' })
      .onConflictDoNothing({ target: companyPhoneNumbers.e164 })
      .returning({ e164: companyPhoneNumbers.e164 });
    if (added[0]) return added[0].e164;
  }
  throw new AppError(409, 'No demo phone number is free for this company.');
}

type Homeowner = { customerId: string | null; name: string | null; phone: string };

/** A customer of the company with a phone number, picked at random so repeated runs vary; else a stranger. */
async function pickHomeowner(deps: AppDeps, companyId: string): Promise<Homeowner> {
  const ctx = systemContext(companyId);
  const rows = await withTenant(deps.pools, ctx, (tx) =>
    tx
      .select({ id: customers.id, name: customers.displayName, phones: customers.phones })
      .from(customers)
      .where(and(isNull(customers.archivedAt), eq(customers.doNotContact, false), sql`jsonb_array_length(${customers.phones}) > 0`))
      .orderBy(desc(customers.updatedAt))
      .limit(25),
  );
  const withPhone = rows.flatMap((r) => {
    const phone = r.phones.find((p) => p.primary)?.e164 ?? r.phones[0]?.e164;
    return phone ? [{ customerId: r.id, name: r.name, phone }] : [];
  });
  if (withPhone.length === 0) return { customerId: null, name: null, phone: STRANGER_E164 };
  return withPhone[Math.floor(Math.random() * withPhone.length)]!;
}

const who = (h: Homeowner) => h.name ?? 'A new homeowner';

/** "Homeowner texts in": an inbound text arrives and Front Desk answers it right away. */
export async function simulateText(deps: AppDeps, companyId: string): Promise<SimulateResult> {
  const to = await companyNumber(deps, companyId);
  const homeowner = await pickHomeowner(deps, companyId);
  const body = DEMO_TEXTS[textTurn++ % DEMO_TEXTS.length]!;
  const messageSid = `SM${randomUUID().replace(/-/g, '')}`;
  await handleInbound(deps, companyId, { messageSid, from: homeowner.phone, to, body });

  const ctx = systemContext(companyId);
  const [conversation] = await withTenant(deps.pools, ctx, (tx) =>
    tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.phoneE164, homeowner.phone), eq(conversations.channel, 'sms'), eq(conversations.status, 'active')))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1),
  );
  if (!conversation) {
    return {
      ok: true,
      customerId: homeowner.customerId,
      conversationId: null,
      message: `${who(homeowner)} texted in. Front Desk texts are off, so the text waits on the customer's timeline.`,
    };
  }
  // The real hook queues a debounced reply; the demo answers now (the queued job then finds nothing unanswered).
  await runFrontDeskText(demoDeps(deps), { companyId, conversationId: conversation.id });
  return {
    ok: true,
    customerId: homeowner.customerId,
    conversationId: conversation.id,
    message: `${who(homeowner)} texted in and Front Desk replied.`,
  };
}

/** Seconds of AI talk time the demo call is billed as. */
const DEMO_CALL_SECONDS = 96;

/** "Incoming call": a homeowner calls, talks with Front Desk over the fake voice session, and hangs up. */
export async function simulateCall(deps: AppDeps, companyId: string): Promise<SimulateResult> {
  const to = await companyNumber(deps, companyId);
  const homeowner = await pickHomeowner(deps, companyId);
  const ctx = systemContext(companyId);
  const demo = demoDeps(deps);
  const callSid = `CA${randomUUID().replace(/-/g, '')}`;
  const startedAt = deps.clock.now();

  const call = await withTenant(deps.pools, ctx, async (tx) => {
    const row = await insertCall(tx, ctx, { callSid, fromE164: homeowner.phone, toE164: to, forwardedFrom: null, stirVerstat: null, now: startedAt });
    await updateCall(tx, ctx, callSid, { status: 'ai', aiStartedAt: startedAt });
    return row;
  });

  const inner = createEngine(demo, FRONT_DESK_HANDLERS);
  let state: ConversationState | null = null;
  const engine: Engine = {
    ...inner,
    start: async (i) => {
      state = await inner.start(i);
      return state;
    },
  };
  const session = new FakeVoiceSession();
  const loop = runRelayLoop(session, {
    deps: demo,
    engine,
    call: { callId: call.id, companyId, callSid, from: homeowner.phone, to, messageOnly: false },
  });
  session.caller.setup({ callSid, from: homeowner.phone, to, customParameters: { callId: call.id } });
  await loop.settled();
  for (const line of DEMO_CALL_LINES) {
    session.caller.say(line);
    await loop.settled();
  }
  session.caller.hangUp();
  await loop.settled();

  const conversationId = (state as ConversationState | null)?.conversationId ?? null;
  if (conversationId === null) throw new Error('The demo call did not start a conversation.');
  await withTenant(deps.pools, ctx, async (tx) => {
    await tx
      .update(calls)
      .set({ conversationId, transcriptStored: true })
      .where(and(eq(calls.companyId, companyId), eq(calls.id, call.id)));
    // As Twilio's status callback would on hang-up: after-call work runs only on a finished call.
    await updateCall(tx, ctx, callSid, { status: 'ended', endedAt: deps.clock.now(), aiSeconds: DEMO_CALL_SECONDS });
    if (homeowner.customerId !== null) {
      await updateConversation(tx, ctx, conversationId, { customerId: homeowner.customerId, identity: 'matched' });
    }
  });
  await runAfterCall(demo, { companyId, callSid });
  return {
    ok: true,
    callId: call.id,
    conversationId,
    customerId: homeowner.customerId,
    message: `${who(homeowner)} called. Front Desk took the call and left a summary.`,
  };
}

/** Owner-role pools for the storm simulation, one per URL, opened on first use. */
const ownerDbs = new Map<string, { db: Db; end: () => Promise<void> }>();

function ownerQuery(url: string): Query {
  let entry = ownerDbs.get(url);
  if (!entry) {
    const pools = createPools({ tenant: url, system: url });
    entry = { db: pools.system, end: () => pools.end() };
    ownerDbs.set(url, entry);
  }
  const { db } = entry;
  return async (text, values) => (await db.$client.query(text, values)).rows as Record<string, unknown>[];
}

/** Ends the owner pools the storm simulation opened (tests and shutdown). */
export async function endDemoOwnerPools(): Promise<void> {
  const all = [...ownerDbs.values()];
  ownerDbs.clear();
  await Promise.all(all.map((e) => e.end()));
}

type Box = [number, number, number, number];
const around = ([lng, lat]: [number, number], dLng: number, dLat: number): Box => [lng - dLng, lat - dLat, lng + dLng, lat + dLat];

/** "Hail storm hits": a storm over the company's book today, matched by the real storm matcher. */
export async function simulateStorm(deps: AppDeps, companyId: string): Promise<SimulateResult> {
  const url = deps.config.DEMO_DATABASE_URL_OWNER;
  if (url === undefined) throw new AppError(409, 'Storm simulation needs DEMO_DATABASE_URL_OWNER set on the API.');
  const ctx = systemContext(companyId);

  // Over the middle of the company's homes when it has any, else over its service area.
  const center = await withTenant(deps.pools, ctx, async (tx) => {
    const [homes] = await tx
      .select({
        lng: sql<number | null>`ST_X(ST_Centroid(ST_Collect(${properties.geom})))::float8`,
        lat: sql<number | null>`ST_Y(ST_Centroid(ST_Collect(${properties.geom})))::float8`,
      })
      .from(properties)
      .where(and(isNull(properties.archivedAt), isNotNull(properties.geom)));
    const [company] = await tx
      .select({
        hasArea: sql<boolean>`${companies.serviceArea} is not null`,
        lng: sql<number | null>`ST_X(ST_Centroid(${companies.serviceArea}))::float8`,
        lat: sql<number | null>`ST_Y(ST_Centroid(${companies.serviceArea}))::float8`,
      })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company?.hasArea) return null;
    if (homes?.lng != null && homes.lat != null) return [Number(homes.lng), Number(homes.lat)] as [number, number];
    return [Number(company.lng), Number(company.lat)] as [number, number];
  });
  if (center === null) throw new AppError(409, 'Set a service area first, so the storm has somewhere to land.');

  const now = deps.clock.now();
  const stormId = await insertFixtureStorm(ownerQuery(url), {
    convectiveDay: now.toISOString().slice(0, 10),
    status: 'provisional',
    contours: [
      { thresholdIn: 0.75, box: around(center, 0.14, 0.1) },
      { thresholdIn: 1.0, box: around(center, 0.08, 0.06) },
      { thresholdIn: 1.5, box: around(center, 0.04, 0.03) },
      { thresholdIn: 2.0, box: around(center, 0.015, 0.012) },
    ],
  });
  const matched = await matchCompany(deps, companyId, now);
  const [companyStorm] = await withTenant(deps.pools, ctx, (tx) =>
    tx.execute(sql`select id, customers_hit, homes_hit from company_storms where storm_id = ${stormId}::uuid`).then((r) => r.rows),
  );
  if (!companyStorm) {
    return { ok: true, stormId, companyStormId: null, message: 'A hail storm passed nearby, but it stayed under your alert threshold.' };
  }
  const row = companyStorm as { id: string; customers_hit: number; homes_hit: number };
  return {
    ok: true,
    stormId,
    companyStormId: row.id,
    created: matched.created.length > 0,
    customersHit: Number(row.customers_hit),
    homesHit: Number(row.homes_hit),
    message: `Hail up to 2 inches hit ${String(row.homes_hit)} homes, ${String(row.customers_hit)} of them your customers.`,
  };
}

/** The demo homeowner's signature: a typed one, no drawing. */
const DEMO_SIGN_IP = '127.0.0.1';
const DEMO_SIGN_AGENT = 'Roofline demo';

/** "Homeowner signs proposal": the most recently sent, unsigned proposal is signed for its middle option. */
export async function simulateSign(deps: AppDeps, companyId: string): Promise<SimulateResult> {
  const ctx: TenantContext = systemContext(companyId);
  const now = deps.clock.now();
  const picked = await withTenant(deps.pools, ctx, async (tx) => {
    const [row] = await tx
      .select({ id: proposals.id, number: proposals.number, customerId: proposals.customerId, name: customers.displayName, linkTokenEncrypted: proposals.linkTokenEncrypted })
      .from(proposals)
      .innerJoin(customers, and(eq(customers.companyId, proposals.companyId), eq(customers.id, proposals.customerId)))
      .where(and(inArray(proposals.status, ['sent', 'viewed']), isNull(proposals.signedAt), sql`${proposals.validUntil} >= ${now.toISOString().slice(0, 10)}::date`))
      .orderBy(desc(proposals.sentAt))
      .limit(1);
    if (!row) return null;
    const view = await publicProposalView(tx, ctx, row.id, now);
    const option = view.options[Math.floor((view.options.length - 1) / 2)] ?? view.options[0];
    return option ? { ...row, optionId: option.id, optionName: option.name } : null;
  });
  if (picked === null) throw new AppError(409, 'No sent proposal is waiting for a signature. Send one first.');

  await signResolvedProposal(
    deps,
    { ctx, proposalId: picked.id },
    { optionId: picked.optionId, signerName: picked.name, typedSignature: picked.name, drawn: null },
    { ip: DEMO_SIGN_IP, userAgent: DEMO_SIGN_AGENT },
  );
  return {
    ok: true,
    proposalId: picked.id,
    customerId: picked.customerId,
    // The homeowner's own page, where the signed copy appears once the worker has made it.
    homeownerUrl: `/p/${encodeURIComponent(decrypt(picked.linkTokenEncrypted, deps.config.ENCRYPTION_KEY))}`,
    message: `${picked.name} signed proposal ${picked.number} (${picked.optionName}).`,
  };
}
