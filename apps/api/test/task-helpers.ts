import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { agentTasks, agentTaskSteps, createCustomer, type TenantContext, withTenant } from '@roofline/db';
import type { StepType } from '@roofline/shared';
import { createTask, type NewTask } from '../src/tasks/service.ts';
import { type Actors, type CompanyKey, inCompany } from './crm-helpers.ts';
import type { TestApp } from './helpers.ts';

/** Shared by the approve, runner and tasks-feed tests. */

export const STALE = "This changed while you were looking. Here's the latest.";
export const HANDLED = 'This was already handled.';
export const EXPIRED = 'This plan expired before it was approved. You can run it again.';
export const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
export const GAVE_UP = "We couldn't finish this step. We'll keep the details here so you can retry.";
export const CANT_RUN = "This kind of step can't run yet.";
export const RETRYING = "This step hit a problem. We'll try it again shortly.";
export const STOP_BODY = "Hi {first_name}, it's {company}. Free roof check this week. Reply STOP to opt out.";

/** The runner / an agent acting for a company: no signed-in person. */
export const agentCtx = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

/** The three demo steps of the F2 demo task: message, internal, spend. */
export const DEMO_STEPS: NewTask['steps'] = [
  { type: 'demo_message', payload: { label: 'Text 31 customers' } },
  { type: 'demo_noop', payload: { label: 'Door-knock routes for 4 reps' } },
  { type: 'demo_spend', payload: { label: 'Google + Facebook ads on the swath', maxSpendCents: 27000 } },
];

/** Creates a task the way an agent does: through the service, inside the company's transaction. */
export function newTask(t: TestApp, company: CompanyKey, input: Partial<NewTask> = {}): Promise<{ taskId: string }> {
  const ctx = agentCtx(t.seed[company].companyId);
  const full: NewTask = {
    agent: 'storm_scout',
    kind: 'storm_plan',
    title: 'Storm plan: Elm Street',
    summary: 'Three steps for the Elm Street hail swath.',
    steps: DEMO_STEPS,
    ...input,
  };
  return withTenant(t.deps.pools, ctx, (tx) => createTask(tx, ctx, full, { now: t.clock.now(), ip: '203.0.113.9' }));
}

/** Adds customers with first names to a company and returns their ids, in the order given. */
export async function newCustomers(t: TestApp, company: CompanyKey, firstNames: string[]): Promise<string[]> {
  const companyId = t.seed[company].companyId;
  const ctx = agentCtx(companyId);
  return inCompany(t, companyId, async (tx) => {
    const ids: string[] = [];
    for (const [i, firstName] of firstNames.entries()) {
      const row = await createCustomer(tx, ctx, { displayName: `${firstName} Test ${i}`, firstName }, { now: t.clock.now() });
      ids.push(row.id);
    }
    return ids;
  });
}

export const smsStep = (customerIds: string[], overrides: Record<string, unknown> = {}) => ({
  type: 'send_sms_batch' as StepType,
  payload: { purpose: 'marketing', body: STOP_BODY, customerIds, ...overrides },
});

export const dbTask = (t: TestApp, company: CompanyKey, id: string) =>
  inCompany(t, t.seed[company].companyId, async (tx) => (await tx.select().from(agentTasks).where(eq(agentTasks.id, id)))[0]!);

export const dbSteps = (t: TestApp, company: CompanyKey, taskId: string) =>
  inCompany(t, t.seed[company].companyId, (tx) =>
    tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, taskId)).orderBy(agentTaskSteps.position),
  );

export const setTask = (t: TestApp, company: CompanyKey, id: string, set: Partial<typeof agentTasks.$inferInsert>) =>
  inCompany(t, t.seed[company].companyId, (tx) => tx.update(agentTasks).set(set).where(eq(agentTasks.id, id)));

export const setStep = (t: TestApp, company: CompanyKey, id: string, set: Partial<typeof agentTaskSteps.$inferInsert>) =>
  inCompany(t, t.seed[company].companyId, (tx) => tx.update(agentTaskSteps).set(set).where(eq(agentTaskSteps.id, id)));

/** What an approve request sends: every step the screen showed, with the version it showed. */
export const seenOf = (steps: readonly { id: string; version: number }[]) => ({
  steps: steps.map((s) => ({ id: s.id, version: s.version })),
});

/** Lets company A's office user approve spend (the owner flips it in the team screen). */
export async function delegateSpendToOffice(t: TestApp, actors: Actors): Promise<void> {
  const owner = await actors.as('owner');
  const team = await owner.get('/api/team');
  const office = team.body.members.find((m: { email: string }) => m.email === t.seed.a.office.email);
  const res = await owner.patch(`/api/team/members/${office.id}`).send({ canApproveSpend: true });
  expect(res.status).toBe(200);
}

/** The step ids the queue was handed, in order. */
export const enqueued = (t: TestApp): string[] => t.queue.calls.map((c) => c.stepId);
