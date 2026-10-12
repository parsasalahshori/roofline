import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { followUpLog, jobs, messages, properties, type StepRow, withTenant } from '@roofline/db';
import type { StepType } from '@roofline/shared';
import { eq } from 'drizzle-orm';
import { sendPersonalTexts } from '../src/agents/personal-texts.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { addSmsCustomers, BATCH_AT, DAY, DAYTIME, rowFor, stepMessages } from './sms-helpers.ts';
import { createTask } from '../src/tasks/service.ts';
import { agentCtx, dbSteps, setStep } from './task-helpers.ts';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
});

const idOf = () => t.seed.a.companyId;

type Msg = { customerId: string; jobId: string | null; body: string };

/** A task with one agent-written `send_personal_texts` step (company A); returns the step as the runner would hand it over. */
async function personalStep(
  messageList: Msg[],
  overrides: Record<string, unknown> = {},
): Promise<{ taskId: string; stepId: string }> {
  const payload = { purpose: 'informational', kind: 'proposal', messages: messageList, dedupePrefix: 'pt:one', ...overrides };
  // send_personal_texts is an agent-only step type (not user creatable), so create it the way the runner copies built-in steps.
  const ctx = agentCtx(idOf());
  const { taskId } = await withTenant(t.deps.pools, ctx, (tx) =>
    createTask(
      tx,
      ctx,
      {
        agent: 'storm_scout',
        kind: 'storm_plan',
        title: 'Personal texts',
        summary: 'One text per customer.',
        steps: [{ type: 'send_personal_texts' as StepType, payload }],
      },
      { now: t.clock.now(), ip: '203.0.113.9', allowInternalStepTypes: true },
    ),
  );
  const step = (await dbSteps(t, 'a', taskId))[0]!;
  return { taskId, stepId: step.id };
}

const stepRow = async (taskId: string): Promise<StepRow> => (await dbSteps(t, 'a', taskId))[0]!;
const run = async (taskId: string) => sendPersonalTexts(t.deps, agentCtx(idOf()), await stepRow(taskId));

const logRows = () => inCompany(t, idOf(), (tx) => tx.select().from(followUpLog).orderBy(followUpLog.at, followUpLog.id));

const NE = { state: 'NE', timezone: 'America/Chicago' } as const;
const FL = { state: 'FL', timezone: 'America/New_York' } as const;

const BAD_BODY = 'Your insurance deductible is covered.';

describe('send_personal_texts', () => {
  test('texts two customers with their own bodies and logs one follow_up_log row each', async () => {
    const [ann, ben] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'express', ...NE },
      { firstName: 'Ben', phone: '+14025550112', consent: 'express', ...NE },
    ]);
    const { taskId, stepId } = await personalStep([
      { customerId: ann!, jobId: null, body: 'Hi Ann, your proposal is ready whenever you are.' },
      { customerId: ben!, jobId: null, body: 'Hi Ben, here is the proposal we talked about.' },
    ]);

    const out = await run(taskId);

    const rows = await stepMessages(t, 'a', stepId);
    expect(rows).toHaveLength(2);
    expect(rowFor(rows, ann!)).toMatchObject({
      status: 'sent',
      body: 'Hi Ann, your proposal is ready whenever you are.',
      dedupeKey: `pt:one:${ann}`,
    });
    expect(rowFor(rows, ben!)).toMatchObject({
      status: 'sent',
      body: 'Hi Ben, here is the proposal we talked about.',
      dedupeKey: `pt:one:${ben}`,
    });
    const log = await logRows();
    expect(log).toHaveLength(2);
    expect(log.find((r) => r.customerId === ann)).toMatchObject({ n: 1, kind: 'proposal' });
    expect(log.find((r) => r.customerId === ben)).toMatchObject({ n: 1, kind: 'proposal' });
    expect(out.result).toEqual({ sent: 2, scheduled: 0, failed: 0, blocked: {} });
  });

  test('a rerun of the same step texts nobody twice', async () => {
    const [ann, ben] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'express', ...NE },
      { firstName: 'Ben', phone: '+14025550112', consent: 'express', ...NE },
    ]);
    const { taskId, stepId } = await personalStep([
      { customerId: ann!, jobId: null, body: 'Hi Ann, your proposal is ready.' },
      { customerId: ben!, jobId: null, body: 'Hi Ben, your proposal is ready.' },
    ]);

    await run(taskId);
    const again = await run(taskId);

    expect(again.result).toEqual({ sent: 2, scheduled: 0, failed: 0, blocked: {} });
    expect(t.sms.sent).toHaveLength(2);
    expect(await stepMessages(t, 'a', stepId)).toHaveLength(2);
    expect(await logRows()).toHaveLength(2);
  });

  test('a claims guard hit at send time blocks only that message', async () => {
    const [ann, ben] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'express', ...NE },
      { firstName: 'Ben', phone: '+14025550112', consent: 'express', ...NE },
    ]);
    const { taskId, stepId } = await personalStep([
      { customerId: ann!, jobId: null, body: 'Hi Ann, your proposal is ready.' },
      { customerId: ben!, jobId: null, body: 'Hi Ben, your proposal is ready.' },
    ]);
    // Written past the step's own validation, as a bad payload that reached the database would be.
    await setStep(t, 'a', stepId, {
      payload: {
        purpose: 'informational',
        kind: 'proposal',
        dedupePrefix: 'pt:one',
        messages: [
          { customerId: ann!, jobId: null, body: BAD_BODY },
          { customerId: ben!, jobId: null, body: 'Hi Ben, your proposal is ready.' },
        ],
      },
    });

    const out = await run(taskId);

    const rows = await stepMessages(t, 'a', stepId);
    expect(rowFor(rows, ann!)).toMatchObject({ status: 'blocked', blockRule: 'content' });
    expect(rowFor(rows, ben!)).toMatchObject({ status: 'sent' });
    expect(out.result).toEqual({ sent: 1, scheduled: 0, failed: 0, blocked: { content: 1 } });
    expect(t.sms.sent.map((m) => m.to)).toEqual(['+14025550112']);
    const log = await logRows();
    expect(log.map((r) => r.customerId)).toEqual([ben]);
  });

  test('a customer who replied 1 day ago is blocked as frequency and a reminder still goes', async () => {
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'express', ...NE }]);
    const at = new Date(t.clock.now().getTime() - DAY);
    await inCompany(t, idOf(), (tx) =>
      tx.insert(messages).values({
        companyId: idOf(),
        customerId: ann!,
        channel: 'sms',
        direction: 'in',
        body: 'Can you call me?',
        status: 'received',
        fromE164: '+14025550111',
        toE164: '+14025550100',
        createdAt: at,
        updatedAt: at,
      }),
    );

    const lead = await personalStep([{ customerId: ann!, jobId: null, body: 'Hi Ann, still interested in a roof check?' }], {
      kind: 'lead',
      dedupePrefix: 'pt:lead',
    });
    const leadOut = await run(lead.taskId);
    expect(rowFor(await stepMessages(t, 'a', lead.stepId), ann!)).toMatchObject({
      status: 'blocked',
      blockRule: 'frequency',
      blockReason: 'They replied recently.',
    });
    expect(leadOut.result).toEqual({ sent: 0, scheduled: 0, failed: 0, blocked: { frequency: 1 } });
    expect(t.sms.sent).toEqual([]);

    const reminder = await personalStep([{ customerId: ann!, jobId: null, body: 'Hi Ann, we are on for tomorrow at 9.' }], {
      kind: 'reminder',
      dedupePrefix: 'pt:rem',
    });
    await run(reminder.taskId);
    expect(rowFor(await stepMessages(t, 'a', reminder.stepId), ann!)).toMatchObject({ status: 'sent' });
    expect(t.sms.sent).toHaveLength(1);
  });

  test('a review request to an express customer is blocked by the gate', async () => {
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'express', ...NE }]);
    const { taskId, stepId } = await personalStep([{ customerId: ann!, jobId: null, body: "Hi Ann, it's Acme Roofing. Would you leave us a review? Reply STOP to opt out." }], {
      purpose: 'marketing',
      kind: 'review',
    });

    const out = await run(taskId);

    expect(rowFor(await stepMessages(t, 'a', stepId), ann!)).toMatchObject({ status: 'blocked', blockRule: 'consent' });
    expect(out.result).toEqual({ sent: 0, scheduled: 0, failed: 0, blocked: { consent: 1 } });
    expect(t.sms.sent).toEqual([]);
  });

  test('quiet hours schedule the text', async () => {
    t.clock.set(BATCH_AT); // 21:30 in New York
    const [rosa] = await addSmsCustomers(t, 'a', [{ firstName: 'Rosa', phone: '+13055550105', consent: 'attested', ...FL }]);
    const { taskId, stepId } = await personalStep([{ customerId: rosa!, jobId: null, body: "Hi Rosa, it's Acme Roofing. Would you leave us a review? Reply STOP to opt out." }], {
      purpose: 'marketing',
      kind: 'review',
    });

    const out = await run(taskId);

    expect(rowFor(await stepMessages(t, 'a', stepId), rosa!)).toMatchObject({ status: 'scheduled', blockRule: 'quiet_hours' });
    expect(out.status).toBe('running');
    expect(out.result).toEqual({ sent: 0, scheduled: 1, failed: 0, blocked: {} });
    expect(t.sms.sent).toEqual([]);
  });

  test('a refused text is retried and sent, and is not blocked by its own follow_up_log row', async () => {
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'express', ...NE }]);
    const { taskId, stepId } = await personalStep([{ customerId: ann!, jobId: null, body: 'Hi Ann, your proposal is ready.' }]);
    t.sms.failNext(1);
    const error = await run(taskId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(rowFor(await stepMessages(t, 'a', stepId), ann!)).toMatchObject({ status: 'failed', retryable: true });
    expect(await logRows()).toHaveLength(1);
    const again = await run(taskId);
    expect(rowFor(await stepMessages(t, 'a', stepId), ann!)).toMatchObject({ status: 'sent', blockRule: null });
    expect(t.sms.sent).toHaveLength(1);
    expect(await logRows()).toHaveLength(1);
    expect(again.result).toEqual({ sent: 1, scheduled: 0, failed: 0, blocked: {} });
  });

  test('the per-claim cap blocks a fifth claims text because the log is read over the whole life of the claim', async () => {
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'express', ...NE }]);
    const jobId = await inCompany(t, idOf(), async (tx) => {
      const [home] = await tx.select({ id: properties.id }).from(properties).where(eq(properties.customerId, ann!));
      const [job] = await tx
        .insert(jobs)
        .values({ companyId: idOf(), customerId: ann!, propertyId: home!.id })
        .returning({ id: jobs.id });
      for (const [i, d] of [17, 13, 9, 5].entries()) {
        await tx.insert(followUpLog).values({
          companyId: idOf(),
          customerId: ann!,
          jobId: job!.id,
          kind: 'claims',
          n: i + 1,
          messageId: null,
          at: new Date(t.clock.now().getTime() - d * DAY),
        });
      }
      return job!.id;
    });
    const step = await personalStep([{ customerId: ann!, jobId, body: 'Hi Ann, any news on your roof claim?' }], {
      kind: 'claims',
      dedupePrefix: 'pt:claims',
    });
    const out = await run(step.taskId);
    expect(rowFor(await stepMessages(t, 'a', step.stepId), ann!)).toMatchObject({
      status: 'blocked',
      blockRule: 'frequency',
      blockReason: 'This claim has had enough reminders.',
    });
    expect(out.result).toEqual({ sent: 0, scheduled: 0, failed: 0, blocked: { frequency: 1 } });
    expect(t.sms.sent).toEqual([]);
    expect((await logRows()).length).toBe(4);
  });

  test('the lease line is the first statement of the loop', () => {
    const source = readFileSync(new URL('../src/agents/personal-texts.ts', import.meta.url), 'utf8');
    const open = source.indexOf('for (const message of messages) {');
    expect(open).toBeGreaterThan(-1);
    const after = source.slice(open + 'for (const message of messages) {'.length).trimStart();
    expect(after.startsWith("if (!(await lease.keep())) return { status: 'running', result: {} };")).toBe(true);
  });

  test('result counts: sent, scheduled and blocked add up exactly', async () => {
    t.clock.set(BATCH_AT);
    const [nina, rosa, pia] = await addSmsCustomers(t, 'a', [
      { firstName: 'Nina', phone: '+14025550101', consent: 'attested', ...NE },
      { firstName: 'Rosa', phone: '+13055550105', consent: 'attested', ...FL },
      { firstName: 'Pia', phone: '+14025550103', consent: 'attested', ...NE },
    ]);
    const { taskId, stepId } = await personalStep(
      [
        { customerId: nina!, jobId: null, body: "Hi Nina, it's Acme Roofing. Would you leave us a review? Reply STOP to opt out." },
        { customerId: rosa!, jobId: null, body: "Hi Rosa, it's Acme Roofing. Would you leave us a review? Reply STOP to opt out." },
        { customerId: pia!, jobId: null, body: "Hi Pia, it's Acme Roofing. Would you leave us a review? Reply STOP to opt out." },
      ],
      { purpose: 'marketing', kind: 'review' },
    );
    await setStep(t, 'a', stepId, {
      payload: {
        purpose: 'marketing',
        kind: 'review',
        dedupePrefix: 'pt:one',
        messages: [
          { customerId: nina!, jobId: null, body: "Hi Nina, it's Acme Roofing. Would you leave us a review? Reply STOP to opt out." },
          { customerId: rosa!, jobId: null, body: "Hi Rosa, it's Acme Roofing. Would you leave us a review? Reply STOP to opt out." },
          { customerId: pia!, jobId: null, body: BAD_BODY },
        ],
      },
    });

    const out = await run(taskId);

    expect(out.result).toEqual({ sent: 1, scheduled: 1, failed: 0, blocked: { content: 1 } });
    const rows = await stepMessages(t, 'a', stepId);
    expect(rowFor(rows, nina!).status).toBe('sent');
    expect(rowFor(rows, rosa!).status).toBe('scheduled');
    expect(rowFor(rows, pia!)).toMatchObject({ status: 'blocked', blockRule: 'content' });
    expect(await inCompany(t, idOf(), (tx) => tx.select().from(followUpLog).where(eq(followUpLog.customerId, pia!)))).toEqual([]);
  });
});

describe('agent code and the insurer', () => {
  test('no agent code uses an adjuster or insurer contact', () => {
    const root = new URL('../src/agents/', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const word of ['adjuster_phone', 'adjusterPhone', 'adjuster_email', 'adjusterEmail']) {
        expect(source.includes(word), `${file} mentions ${word}`).toBe(false);
      }
    }
  });
});
