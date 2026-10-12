import { createHmac } from 'node:crypto';
import type pg from 'pg';
import {
  calls,
  companyPhoneNumbers,
  conversations,
  conversationTurns,
  customers,
  encrypt,
  withTenant,
  type Pools,
  type TenantContext,
  type ToolCallRecord,
} from '@roofline/db';
import { readStack, type Scenario } from './fixtures.ts';

/*
 * The Front Desk e2e world (D1 Task 27). The stack has no scripted phone call to drive from a
 * browser test, so the specs start from rows written the way the engine writes them: conversations,
 * calls and turns, through the same tenant pool the API uses. Everything here is fake: 555 numbers,
 * made-up names, no provider is reached.
 */

/** Acme's Roofline number (the one calls are forwarded to). */
export const ROOFLINE_NUMBER = '+14025550200';
/** Acme's own business phone, seeded as companies.phone_e164 by seedTwoCompanies. */
export const BUSINESS_PHONE = '+14025550199';
const SUBACCOUNT_TOKEN = 'e2e-subaccount-token';

export const MARIA = { name: 'Maria Alvarez', phone: '+14025550141' };
export const TOM = { name: 'Tom Reyes', phone: '+14025550142' };
export const LEAK_CALLER = { phone: '+14025550143' };
export const SPAM_CALLER = { phone: '+14025550144' };
export const LIVE_CALLER = { phone: '+14025550150' };

export type FrontDeskSeed = {
  /** Conversation ids by name. */
  ids: { live: string; maria: string; tom: string; leak: string; spam: string };
  /** The call id of the spam-pitch call and of the leak message call (for the Mark as spam button). */
  leakCallId: string;
};

const MINUTE = 60_000;

const ctxOf = (scenario: Scenario): TenantContext => ({
  companyId: scenario.a.companyId,
  userId: null,
  role: 'system',
  canApproveSpend: false,
});

/** A zone whose wall clock is between 10:00 and 17:59 now, so a staff text is never held for quiet hours. */
export function daytimeZone(now: Date): string {
  const zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
  for (const zone of zones) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(now));
    if (hour >= 10 && hour < 18) return zone;
  }
  return 'America/Chicago';
}

let sidCounter = 0;
const nextSid = () => `CA${'e2'}${(++sidCounter).toString(16).padStart(30, '0')}`;

/**
 * Gives Acme a Roofline number with a signing token (the voice webhook is signed with the company's
 * subaccount token), and a company time zone where it is daytime now.
 */
export async function seedRooflineNumber(pools: Pools, db: pg.Client, scenario: Scenario): Promise<void> {
  const { companyId } = scenario.a;
  await pools.system
    .insert(companyPhoneNumbers)
    .values({ companyId, e164: ROOFLINE_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_e2e_a' });
  await db.query(`update texting_registrations set subaccount_auth_token_encrypted = $1 where company_id = $2`, [
    encrypt(SUBACCOUNT_TOKEN, readStack().encryptionKey),
    companyId,
  ]);
  await db.query(`update companies set timezone = $1 where id = $2`, [daytimeZone(new Date()), companyId]);
}

/** The form fields and signature of a call Twilio would forward from the business line to the Roofline number. */
export function signedForwardedCall(from: string): { url: string; fields: Record<string, string>; signature: string } {
  const stack = readStack();
  const url = `${stack.baseUrl}/hooks/twilio/voice`;
  const fields: Record<string, string> = {
    CallSid: nextSid(),
    From: from,
    To: ROOFLINE_NUMBER,
    ForwardedFrom: BUSINESS_PHONE,
  };
  // Twilio's scheme: the URL plus every field name and value in name order, HMAC-SHA1 with the token, base64.
  const data = Object.keys(fields)
    .sort()
    .reduce((acc, key) => acc + key + fields[key], url);
  const signature = createHmac('sha1', SUBACCOUNT_TOKEN).update(data, 'utf8').digest('base64');
  return { url, fields, signature };
}

type TurnSeed = {
  speaker: 'caller' | 'assistant' | 'team';
  text: string;
  toolCalls?: ToolCallRecord[];
};

/**
 * Five conversations: a call in progress, a booked call with action cards, a text thread waiting for a
 * reply, an urgent message left by an unknown caller, and a spam pitch. Three need attention (unread).
 */
export async function seedFrontDesk(pools: Pools, scenario: Scenario): Promise<FrontDeskSeed> {
  const ctx = ctxOf(scenario);
  const { companyId } = scenario.a;
  const now = Date.now();

  return withTenant(pools, ctx, async (tx) => {
    const customer = async (c: { name: string; phone: string }): Promise<string> => {
      const [row] = await tx
        .insert(customers)
        .values({
          companyId,
          displayName: c.name,
          firstName: c.name.split(' ')[0] ?? c.name,
          phones: [{ e164: c.phone, label: 'mobile', primary: true }],
          smsConsentStatus: 'attested',
        })
        .returning({ id: customers.id });
      return row!.id;
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
          companyNumberE164: ROOFLINE_NUMBER,
          outcome: o.outcome ?? null,
          unreadCount: o.unread ?? 0,
          summary: o.summary ?? null,
          identity: o.identity ?? 'unknown',
          lastMessageAt: new Date(now - o.minutesAgo * MINUTE),
        })
        .returning({ id: conversations.id });
      return row!.id;
    };

    const call = async (
      conversationId: string,
      from: string,
      o: { status: 'ai' | 'ended'; transcriptStored: boolean; spamReason?: string; minutesAgo: number },
    ): Promise<string> => {
      const [row] = await tx
        .insert(calls)
        .values({
          companyId,
          conversationId,
          callSid: nextSid(),
          fromE164: from,
          toE164: ROOFLINE_NUMBER,
          status: o.status,
          startedAt: new Date(now - o.minutesAgo * MINUTE),
          endedAt: o.status === 'ended' ? new Date(now - (o.minutesAgo - 2) * MINUTE) : null,
          aiSeconds: o.status === 'ended' ? 95 : 0,
          transcriptStored: o.transcriptStored,
          recordingStatus: 'none',
          spamReason: o.spamReason ?? null,
        })
        .returning({ id: calls.id });
      return row!.id;
    };

    const turns = async (conversationId: string, callId: string | null, list: TurnSeed[], minutesAgo: number): Promise<void> => {
      for (const [position, turn] of list.entries()) {
        await tx.insert(conversationTurns).values({
          companyId,
          conversationId,
          callId,
          position,
          speaker: turn.speaker,
          text: turn.text,
          at: new Date(now - (minutesAgo - position * 0.2) * MINUTE),
          toolCalls: turn.toolCalls ?? null,
        });
      }
    };

    const mariaId = await customer(MARIA);
    const tomId = await customer(TOM);

    const live = await conversation({ channel: 'voice', phone: LIVE_CALLER.phone, minutesAgo: 1 });
    await call(live, LIVE_CALLER.phone, { status: 'ai', transcriptStored: true, minutesAgo: 1 });

    const maria = await conversation({
      channel: 'voice',
      phone: MARIA.phone,
      customerId: mariaId,
      outcome: 'booked',
      unread: 1,
      summary: 'Maria booked an inspection for Thursday at 10:00 AM.',
      identity: 'matched',
      minutesAgo: 20,
    });
    const mariaCall = await call(maria, MARIA.phone, { status: 'ended', transcriptStored: true, minutesAgo: 22 });
    await turns(
      maria,
      mariaCall,
      [
        {
          speaker: 'assistant',
          text: "Thanks for calling Acme Roofing. I'm Acme Roofing's virtual assistant, and this call is recorded. How can I help?",
        },
        { speaker: 'caller', text: 'I found shingles in my yard and I would like someone to look at the roof.' },
        { speaker: 'assistant', text: 'I can have an inspector out Thursday at 10:00 AM. Does that work?' },
        { speaker: 'caller', text: 'Yes, please.' },
        {
          speaker: 'assistant',
          text: 'You are booked for Thursday at 10:00 AM. You will get a text to confirm.',
          toolCalls: [{ name: 'book_inspection', input: {}, result: 'Booked', ok: true }],
        },
      ],
      22,
    );

    const tom = await conversation({
      channel: 'sms',
      phone: TOM.phone,
      customerId: tomId,
      unread: 2,
      identity: 'matched',
      minutesAgo: 5,
    });
    await turns(
      tom,
      null,
      [
        { speaker: 'caller', text: 'Hi, can someone look at my roof this week?' },
        { speaker: 'caller', text: 'It is on Maple Street.' },
      ],
      6,
    );

    const leak = await conversation({
      channel: 'voice',
      phone: LEAK_CALLER.phone,
      outcome: 'message',
      unread: 1,
      summary: 'The caller reported a leak and asked for a call back.',
      minutesAgo: 40,
    });
    const leakCall = await call(leak, LEAK_CALLER.phone, { status: 'ended', transcriptStored: true, minutesAgo: 42 });
    await turns(
      leak,
      leakCall,
      [
        { speaker: 'caller', text: 'Water is coming through my ceiling, please have someone call me.' },
        {
          speaker: 'assistant',
          text: 'I have taken your message and marked it urgent. Someone will call you back.',
          toolCalls: [{ name: 'take_message', input: { urgent: true }, result: 'Taken', ok: true }],
        },
      ],
      42,
    );

    const spam = await conversation({
      channel: 'voice',
      phone: SPAM_CALLER.phone,
      outcome: 'spam',
      summary: 'A sales pitch. The call was ended.',
      minutesAgo: 90,
    });
    await call(spam, SPAM_CALLER.phone, { status: 'ended', transcriptStored: false, spamReason: 'sales_pitch', minutesAgo: 91 });

    return { ids: { live, maria, tom, leak, spam }, leakCallId: leakCall };
  });
}
