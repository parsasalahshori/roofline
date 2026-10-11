import { asc, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { customers, messages, optOuts, properties, usageEvents } from '@roofline/db';
import type { OutboundSms, SmsAdapter, SmsSendResult } from '@roofline/send-gate';
import type { ConsentStatus } from '@roofline/shared';
import { type Actors, type CompanyKey, inCompany } from './crm-helpers.ts';
import type { TestApp } from './helpers.ts';
import { dbSteps, newTask, seenOf, smsStep } from './task-helpers.ts';

/** Shared by the send-batch and dispatcher tests. */

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Wednesday 14 October 2026, 20:30 in Chicago (CDT, UTC-5): 21:30 in New York, past Florida's 20:00. */
export const BATCH_AT = new Date('2026-10-15T01:30:00.000Z');
/** Thursday 15 October 2026, 08:00 in New York (EDT, UTC-4): when Florida's quiet hours end. */
export const NEXT_MORNING_NY = new Date('2026-10-15T12:00:00.000Z');
/** 10:00 on a Tuesday in Chicago: inside everyone's sending hours. */
export const DAYTIME = new Date('2026-10-13T15:00:00.000Z');

export const UNCONFIRMED = "We couldn't confirm this text was sent, so we didn't resend it.";
export const NO_LOCAL_TIME = "We couldn't work out this customer's local time.";
export const NOT_TAKEN = "The texting service didn't take this message. We'll try again.";
export const OPTED_OUT = 'This customer asked not to be texted.';
export const NO_MOBILE = 'No mobile number on file.';
export const NO_CONSENT = 'No texting consent on file.';

/** One test customer: their number (or none), consent, and optionally a home with a state and zone. */
export type SmsCustomer = {
  firstName: string;
  phone: string | null;
  consent: ConsentStatus;
  state?: string;
  timezone?: string | null;
  optedOut?: boolean;
  doNotContact?: boolean;
};

/** The brief's five: c1 sends, c2 lacks marketing consent, c3 opted out, c4 has no number, c5 lives in Florida. */
export const BRIEF_FIVE: SmsCustomer[] = [
  { firstName: 'Nina', phone: '+14025550101', consent: 'attested', state: 'NE', timezone: 'America/Chicago' },
  { firstName: 'Omar', phone: '+14025550102', consent: 'express', state: 'NE', timezone: 'America/Chicago' },
  { firstName: 'Pia', phone: '+14025550103', consent: 'attested', optedOut: true },
  { firstName: 'Quinn', phone: null, consent: 'attested' },
  { firstName: 'Rosa', phone: '+13055550105', consent: 'attested', state: 'FL', timezone: 'America/New_York' },
];

let addressCounter = 0;

/** Inserts the customers (and their homes and opt-outs) straight into the company's tables, and returns their ids in order. */
export async function addSmsCustomers(t: TestApp, company: CompanyKey, list: readonly SmsCustomer[]): Promise<string[]> {
  const companyId = t.seed[company].companyId;
  const now = t.clock.now();
  return inCompany(t, companyId, async (tx) => {
    const ids: string[] = [];
    for (const c of list) {
      const [row] = await tx
        .insert(customers)
        .values({
          companyId,
          displayName: `${c.firstName} Customer`,
          firstName: c.firstName,
          phones: c.phone === null ? [] : [{ e164: c.phone, label: 'mobile', primary: true }],
          smsConsentStatus: c.consent,
          doNotContact: c.doNotContact ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: customers.id });
      const customerId = row!.id;
      ids.push(customerId);
      if (c.state !== undefined) {
        const n = (addressCounter += 1);
        await tx.insert(properties).values({
          companyId,
          customerId,
          addressLine: `${n} Elm St`,
          city: 'Springfield',
          state: c.state,
          zip: '68102',
          addressKey: `${n} elm st|68102`,
          timezone: c.timezone ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (c.optedOut === true && c.phone !== null) {
        await tx.insert(optOuts).values({ companyId, phoneE164: c.phone, keyword: 'stop', at: now, createdAt: now, updatedAt: now });
      }
    }
    return ids;
  });
}

/** Makes a one-step `send_sms_batch` task for these customers and has the owner approve it. The step is then queued. */
export async function approvedBatch(
  t: TestApp,
  actors: Actors,
  customerIds: string[],
  overrides: Record<string, unknown> = {},
  company: CompanyKey = 'a',
): Promise<{ taskId: string; stepId: string }> {
  const { taskId } = await newTask(t, company, { steps: [smsStep(customerIds, overrides)] });
  const steps = await dbSteps(t, company, taskId);
  const res = await (await actors.as('owner', company)).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
  expect(res.status).toBe(200);
  return { taskId, stepId: steps[0]!.id };
}

/** Every message row of a step. */
export const stepMessages = (t: TestApp, company: CompanyKey, stepId: string) =>
  inCompany(t, t.seed[company].companyId, (tx) =>
    tx.select().from(messages).where(eq(messages.stepId, stepId)).orderBy(asc(messages.createdAt), asc(messages.id)),
  );

/** The message row of one customer, from a list of rows. */
export function rowFor<T extends { customerId: string | null }>(rows: readonly T[], customerId: string): T {
  const row = rows.find((r) => r.customerId === customerId);
  if (!row) throw new Error(`No message row for customer ${customerId}`);
  return row;
}

/** Every usage row of a company. */
export const usageRows = (t: TestApp, company: CompanyKey) =>
  inCompany(t, t.seed[company].companyId, (tx) => tx.select().from(usageEvents).orderBy(asc(usageEvents.createdAt)));

/** A promise that resolves when `open()` is called. */
export function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * A provider that holds every send until `waitFor` sends are being held at once, then lets them all
 * through (and every later one straight away). Two runs that are each in the middle of a send are
 * then known to overlap.
 */
export class HeldSmsAdapter implements SmsAdapter {
  private held = 0;
  private readonly release = gate();

  constructor(
    private readonly inner: SmsAdapter,
    private readonly waitFor: number,
  ) {}

  async send(m: OutboundSms): Promise<SmsSendResult> {
    this.held += 1;
    if (this.held >= this.waitFor) this.release.open();
    await this.release.opened;
    return this.inner.send(m);
  }

  /** Lets everything through now (for a test that ends before enough sends arrive). */
  openAll(): void {
    this.release.open();
  }
}

/** The numbers a fake provider was asked to text, sorted. */
export const sentTo = (sent: readonly OutboundSms[]) => sent.map((m) => m.to).sort();
