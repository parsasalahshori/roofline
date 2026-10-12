import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentSettings,
  agentTasks,
  appointments,
  createAppointment,
  createCustomer,
  createJob,
  createProperty,
  setPaused,
  type TenantContext,
} from '@roofline/db';
import { runAgenda } from '../src/agents/scheduler/agenda.ts';
import type { JobMeta } from '../src/jobs/queue.ts';
import { dbAudit, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const META: JobMeta = { attempt: 1, lastAttempt: false };
/** 6 PM on Monday 2026-10-12 in Chicago (CDT, UTC-5). */
const SIX_PM = new Date('2026-10-12T23:00:00.000Z');
const SUBJECT = 'Your appointments for Tuesday, Oct 13';
const PHONE = '+15125550101';
const PHONE_DIGITS = '5125550101';

/** Tuesday 2026-10-13, Chicago local hour h (CDT = UTC-5). */
const tue = (h: number): Date => new Date(Date.UTC(2026, 9, 13, h + 5));
/** Monday 2026-10-12, Chicago local hour h. */
const mon = (h: number): Date => new Date(Date.UTC(2026, 9, 12, h + 5));

let t: TestApp;
const A = () => t.seed.a.companyId;
const B = () => t.seed.b.companyId;
const ctxOf = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

type Visit = { name: string; address: string; notes: string; start: Date; end: Date; canceled?: boolean };

/** A customer, house and job, and a scheduled inspection assigned to `userId`. */
async function seedVisit(companyId: string, userId: string, v: Visit): Promise<{ jobId: string }> {
  const ctx = ctxOf(companyId);
  const now = t.clock.now();
  return inCompany(t, companyId, async (tx) => {
    const customer = await createCustomer(
      tx,
      ctx,
      { displayName: v.name, firstName: v.name.split(' ')[0]!, phones: [{ e164: PHONE, primary: true }] },
      { now },
    );
    const property = await createProperty(
      tx,
      ctx,
      { customerId: customer.id, addressLine: v.address, city: 'Austin', state: 'TX', zip: '78701' },
      { now },
    );
    const job = await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id }, { now });
    const { row } = await createAppointment(
      tx,
      ctx,
      {
        kind: 'inspection',
        customerId: customer.id,
        propertyId: property.id,
        jobId: job.id,
        assignedUserId: userId,
        startsAt: v.start,
        endsAt: v.end,
        notes: v.notes,
      },
      now,
    );
    if (v.canceled) await tx.update(appointments).set({ status: 'canceled' }).where(eq(appointments.id, row.id));
    return { jobId: job.id };
  });
}

const agentOn = (companyId: string) => inCompany(t, companyId, (tx) => setPaused(tx, ctxOf(companyId), 'scheduler', false, t.clock.now()));
const mailTo = (email: string) => t.mailer.sent.filter((m) => m.to === email);

describe('runAgenda', () => {
  let ownerEmail: string;
  let officeEmail: string;

  beforeEach(async () => {
    t = await makeTestApp();
    t.clock.set(SIX_PM);
    ownerEmail = t.seed.a.owner.email;
    officeEmail = t.seed.a.office.email;
    await agentOn(A());
  });

  test('one email per member with the right visits in time order', async () => {
    const owner = t.seed.a.owner.userId;
    const office = t.seed.a.office.userId;
    // The later visit is created first, so creation order is not time order.
    const o2 = await seedVisit(A(), owner, { name: 'Late Olson', address: '22 Late Ln', notes: 'owner-late-note', start: tue(14), end: tue(15) });
    const o1 = await seedVisit(A(), owner, { name: 'Early Olson', address: '11 Early Ln', notes: 'owner-early-note', start: tue(9), end: tue(10) });
    const f2 = await seedVisit(A(), office, { name: 'Late Frost', address: '44 Late Rd', notes: 'office-late-note', start: tue(15), end: tue(16) });
    const f1 = await seedVisit(A(), office, { name: 'Early Frost', address: '33 Early Rd', notes: 'office-early-note', start: tue(10), end: tue(11) });

    await runAgenda(t.deps, A(), META);

    expect(t.mailer.sent).toHaveLength(2);
    const origin = t.deps.config.APP_ORIGIN;
    const cases = [
      { email: ownerEmail, first: o1.jobId, second: o2.jobId, names: ['Early Olson', 'Late Olson'], addrs: ['11 Early Ln', '22 Late Ln'], notes: ['owner-early-note', 'owner-late-note'] },
      { email: officeEmail, first: f1.jobId, second: f2.jobId, names: ['Early Frost', 'Late Frost'], addrs: ['33 Early Rd', '44 Late Rd'], notes: ['office-early-note', 'office-late-note'] },
    ];
    for (const c of cases) {
      const mails = mailTo(c.email);
      expect(mails).toHaveLength(1);
      const mail = mails[0]!;
      expect(mail.subject).toBe(SUBJECT);
      for (const piece of [...c.names, ...c.addrs, ...c.notes, `${origin}/jobs/${c.first}`, `${origin}/jobs/${c.second}`]) {
        expect(mail.text).toContain(piece);
      }
      expect(mail.text.replace(/\D/g, '')).toContain(PHONE_DIGITS);
      expect(mail.text.indexOf(c.names[0]!)).toBeLessThan(mail.text.indexOf(c.names[1]!));
      expect(mail.text.indexOf(c.addrs[0]!)).toBeLessThan(mail.text.indexOf(c.addrs[1]!));
      expect(mail.text.indexOf(`/jobs/${c.first}`)).toBeLessThan(mail.text.indexOf(`/jobs/${c.second}`));
    }
  });

  test('a member with no visits gets nothing', async () => {
    await seedVisit(A(), t.seed.a.owner.userId, { name: 'Only Olson', address: '1 Only St', notes: 'n', start: tue(9), end: tue(10) });
    await runAgenda(t.deps, A(), META);
    expect(mailTo(ownerEmail)).toHaveLength(1);
    expect(mailTo(officeEmail)).toHaveLength(0);
    expect(t.mailer.sent).toHaveLength(1);
  });

  test('a second run the same day sends nothing new', async () => {
    await seedVisit(A(), t.seed.a.owner.userId, { name: 'Olson One', address: '1 One St', notes: 'n1', start: tue(9), end: tue(10) });
    await seedVisit(A(), t.seed.a.office.userId, { name: 'Frost One', address: '2 One St', notes: 'n2', start: tue(9), end: tue(10) });

    await runAgenda(t.deps, A(), META);
    expect(t.mailer.sent).toHaveLength(2);
    await runAgenda(t.deps, A(), META);
    expect(t.mailer.sent).toHaveLength(2);

    const rows = await dbAudit(t, A(), 'agenda.email_sent');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.targetId).sort()).toEqual([t.seed.a.owner.userId, t.seed.a.office.userId].sort());
  });

  test("canceled and today's visits are left out", async () => {
    const owner = t.seed.a.owner.userId;
    await seedVisit(A(), owner, { name: 'Kept Olson', address: '1 Kept St', notes: 'kept-note', start: tue(9), end: tue(10) });
    await seedVisit(A(), owner, { name: 'Canceled Olson', address: '2 Gone St', notes: 'gone-note', start: tue(11), end: tue(12), canceled: true });
    await seedVisit(A(), owner, { name: 'Today Olson', address: '3 Today St', notes: 'today-note', start: mon(19), end: mon(20) });

    await runAgenda(t.deps, A(), META);

    const mails = mailTo(ownerEmail);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('Kept Olson');
    expect(mails[0]!.text).not.toContain('Canceled Olson');
    expect(mails[0]!.text).not.toContain('Today Olson');
    expect(mails[0]!.text).not.toContain('gone-note');
    expect(mails[0]!.text).not.toContain('today-note');
  });

  test('paused (no agent_settings row) sends nothing, and agent on sends', async () => {
    await seedVisit(A(), t.seed.a.owner.userId, { name: 'Olson One', address: '1 One St', notes: 'n1', start: tue(9), end: tue(10) });
    await t.deps.pools.system.delete(agentSettings).where(eq(agentSettings.agent, 'scheduler'));

    await runAgenda(t.deps, A(), META);
    expect(t.mailer.sent).toHaveLength(0);

    await agentOn(A());
    await runAgenda(t.deps, A(), META);
    expect(t.mailer.sent).toHaveLength(1);
  });

  test('no task is created', async () => {
    await seedVisit(A(), t.seed.a.owner.userId, { name: 'Olson One', address: '1 One St', notes: 'n1', start: tue(9), end: tue(10) });
    await runAgenda(t.deps, A(), META);
    expect(t.mailer.sent).toHaveLength(1);
    const rows = await inCompany(t, A(), (tx) => tx.select().from(agentTasks).where(eq(agentTasks.agent, 'scheduler')));
    expect(rows).toHaveLength(0);
  });

  test("a different company's visits never appear", async () => {
    await agentOn(B());
    await seedVisit(A(), t.seed.a.owner.userId, { name: 'Acme Olson', address: '1 Acme St', notes: 'acme-note', start: tue(9), end: tue(10) });
    await seedVisit(B(), t.seed.b.owner.userId, { name: 'Bolt Zeller', address: '9 Bolt Blvd', notes: 'bolt-note', start: tue(9), end: tue(10) });

    await runAgenda(t.deps, A(), META);

    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]!.to).toBe(ownerEmail);
    for (const m of t.mailer.sent) {
      expect(m.text).not.toContain('Bolt Zeller');
      expect(m.text).not.toContain('9 Bolt Blvd');
      expect(m.text).not.toContain('bolt-note');
    }
    expect(mailTo(t.seed.b.owner.email)).toHaveLength(0);
  });
});
