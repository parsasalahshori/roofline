import { beforeEach, describe, expect, test } from 'vitest';
import { agentTasks, agentTaskSteps, auditLog, customers, jobs, properties, type Tx } from '@roofline/db';
import { Actors, addressFor, dbAudit, dbCustomer, dbJob, dbProperty, inCompany, mustCreate, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';
import { dbSteps, dbTask, newTask, seenOf, setStep, setTask } from './task-helpers.ts';

/*
 * The tenant-isolation sweep. Company A has a customer, an address and a job. Company B's owner (a
 * fully signed-in, fully privileged member of a different company) calls every route that takes one
 * of A's ids. Each row says what B must get back: a 404 (the id is not B's, so it does not exist as
 * far as B can tell), or an empty list for list routes that filter by an id. The approval routes
 * (Task 14) have their own table at the end of the file, since each needs A's task in a different
 * state for A's own call to succeed.
 *
 * The activities timeline is a 404 as well, not an empty list: Task 10 made "a subject you cannot open"
 * the same answer on every route, so a timeline cannot be used to probe whether an id exists.
 */

type Expectation = 404 | 'empty';

const routes: [method: string, path: string, expect: Expectation][] = [
  ['GET', '/api/customers/:customerId', 404],
  ['PATCH', '/api/customers/:customerId', 404],
  ['POST', '/api/customers/:customerId/archive', 404],
  ['POST', '/api/customers/:customerId/unarchive', 404],
  ['GET', '/api/properties/:propertyId', 404],
  ['PATCH', '/api/properties/:propertyId', 404],
  ['POST', '/api/properties/:propertyId/archive', 404],
  ['POST', '/api/properties/:propertyId/unarchive', 404],
  ['GET', '/api/jobs/:jobId', 404],
  ['PATCH', '/api/jobs/:jobId', 404],
  ['POST', '/api/jobs/:jobId/archive', 404],
  ['POST', '/api/jobs/:jobId/unarchive', 404],
  ['GET', '/api/activities?subjectType=customer&subjectId=:customerId', 404],
  ['GET', '/api/activities?subjectType=property&subjectId=:propertyId', 404],
  ['GET', '/api/activities?subjectType=job&subjectId=:jobId', 404],
  // Lists narrowed by one of A's ids: nothing of A's comes back.
  ['GET', '/api/jobs?customerId=:customerId', 'empty'],
  ['GET', '/api/jobs?propertyId=:propertyId', 'empty'],
  ['GET', '/api/properties?customerId=:customerId', 'empty'],
];

/** A valid change for each PATCH, so a 404 is the lookup failing and not the body being refused first. */
const patchBodies: Record<string, Record<string, unknown>> = {
  '/api/customers/:customerId': { displayName: 'Taken over' },
  '/api/properties/:propertyId': { city: 'Taken over' },
  '/api/jobs/:jobId': { stage: 'won', valueCents: 1 },
};

let t: TestApp;
let who: Actors;
let ids: { customerId: string; propertyId: string; jobId: string };
let aOwner: SuperAgent;
let bOwner: SuperAgent;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  aOwner = await who.as('owner', 'a');
  bOwner = await who.as('owner', 'b');
  const customer = await mustCreate(aOwner, '/api/customers', { displayName: "A's customer", phones: [{ number: '(402) 555-0144' }] });
  const property = await mustCreate(aOwner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  const job = await mustCreate(aOwner, '/api/jobs', { customerId: customer.id, propertyId: property.id, valueCents: 900_000 });
  ids = { customerId: customer.id, propertyId: property.id, jobId: job.id };
});

const fill = (path: string) =>
  path.replace(':customerId', ids.customerId).replace(':propertyId', ids.propertyId).replace(':jobId', ids.jobId);

describe("company B's owner against company A's ids", () => {
  test.each(routes)('%s %s → %s', async (method, path, expected) => {
    const url = fill(path);
    const base = path.split('?')[0]!;
    const req =
      method === 'GET'
        ? bOwner.get(url)
        : method === 'PATCH'
          ? bOwner.patch(url).send(patchBodies[base] ?? {})
          : bOwner.post(url).send({});
    const res = await req;
    if (expected === 404) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    } else {
      expect(res.status).toBe(200);
      const [list] = Object.values(res.body).filter(Array.isArray);
      expect(list).toEqual([]);
      expect(res.body.total).toBe(0);
    }
  });

  test('every row of the table agrees with A itself: the same call from A works', async () => {
    // Guards the table against passing for the wrong reason (a typo in the path, a body that is refused).
    for (const [method, path, expected] of routes) {
      if (method === 'POST' && path.endsWith('/unarchive')) continue; // nothing to restore yet
      // The archive rows above have run by now, so the lists must be asked to include what they archived.
      const url = fill(path) + (expected === 'empty' ? '&includeArchived=true' : '');
      const base = path.split('?')[0]!;
      const res =
        method === 'GET'
          ? await aOwner.get(url)
          : method === 'PATCH'
            ? await aOwner.patch(url).send(patchBodies[base] ?? {})
            : await aOwner.post(url).send({});
      expect(res.status, `${method} ${path}`).toBe(200);
      if (expected === 'empty') expect(res.body.total, `${method} ${path}`).toBe(1);
    }
  });

  test('after the whole sweep, none of A\'s data has changed and B\'s audit log is empty', async () => {
    for (const [method, path] of routes) {
      const url = fill(path);
      const base = path.split('?')[0]!;
      if (method === 'PATCH') await bOwner.patch(url).send(patchBodies[base] ?? {});
      else if (method === 'POST') await bOwner.post(url).send({});
    }
    expect((await dbCustomer(t, t.seed.a.companyId, ids.customerId)).displayName).toBe("A's customer");
    expect((await dbCustomer(t, t.seed.a.companyId, ids.customerId)).archivedAt).toBeNull();
    expect((await dbProperty(t, t.seed.a.companyId, ids.propertyId)).city).toBe('Omaha');
    expect((await dbProperty(t, t.seed.a.companyId, ids.propertyId)).archivedAt).toBeNull();
    const job = await dbJob(t, t.seed.a.companyId, ids.jobId);
    expect(job).toMatchObject({ stage: 'lead', valueCents: 900_000, archivedAt: null });
    expect(await inCompany(t, t.seed.b.companyId, (tx) => tx.select().from(auditLog))).toEqual([]);
    expect(await dbAudit(t, t.seed.a.companyId, 'job.update')).toEqual([]);
  });

  test("B's lists never include A's records", async () => {
    for (const path of ['/api/customers', '/api/properties', '/api/jobs']) {
      const res = await bOwner.get(path);
      expect(res.status, path).toBe(200);
      expect(res.body.total, path).toBe(0);
    }
    expect((await bOwner.get('/api/customers?q=customer')).body.total).toBe(0);
    expect((await bOwner.get('/api/customers?q=555-0144')).body.total).toBe(0);
    expect((await bOwner.get('/api/properties?q=Oak')).body.total).toBe(0);
    // ... and A's own are all there for A.
    expect((await aOwner.get('/api/customers')).body.total).toBe(1);
    expect((await aOwner.get('/api/properties')).body.total).toBe(1);
    expect((await aOwner.get('/api/jobs')).body.total).toBe(1);
  });

  test("B cannot point its own records at A's: customer, address and assignee ids from A are refused", async () => {
    const bCustomer = await mustCreate(bOwner, '/api/customers', { displayName: "B's customer" });
    const bProperty = await mustCreate(bOwner, '/api/properties', { customerId: bCustomer.id, ...addressFor(0) });
    const bJob = await mustCreate(bOwner, '/api/jobs', { customerId: bCustomer.id, propertyId: bProperty.id });

    const cases = [
      await bOwner.post('/api/properties').send({ customerId: ids.customerId, ...addressFor(1) }),
      await bOwner.patch(`/api/properties/${bProperty.id}`).send({ customerId: ids.customerId }),
      await bOwner.post('/api/jobs').send({ customerId: ids.customerId, propertyId: bProperty.id }),
      await bOwner.post('/api/jobs').send({ customerId: bCustomer.id, propertyId: ids.propertyId }),
      await bOwner.patch(`/api/jobs/${bJob.id}`).send({ customerId: ids.customerId }),
      await bOwner.patch(`/api/jobs/${bJob.id}`).send({ propertyId: ids.propertyId }),
      await bOwner.post('/api/jobs').send({ customerId: bCustomer.id, propertyId: bProperty.id, assignedUserId: who.user('rep', 'a').userId }),
      await bOwner.patch(`/api/jobs/${bJob.id}`).send({ assignedUserId: who.user('owner', 'a').userId }),
    ];
    for (const res of cases) expect(res.status).toBe(400);
    expect(cases.map((r) => r.body.field)).toEqual([
      'customerId',
      'customerId',
      'customerId',
      'propertyId',
      'customerId',
      'propertyId',
      'assignedUserId',
      'assignedUserId',
    ]);

    const [bProp, bJobRow] = [await dbProperty(t, t.seed.b.companyId, bProperty.id), await dbJob(t, t.seed.b.companyId, bJob.id)];
    expect(bProp.customerId).toBe(bCustomer.id);
    expect(bJobRow).toMatchObject({ customerId: bCustomer.id, propertyId: bProperty.id, assignedUserId: null });
  });

  test('the same street address in two companies is two separate addresses', async () => {
    const res = await bOwner.post('/api/properties').send(addressFor(0));
    expect(res.status).toBe(201);
    const again = await bOwner.post('/api/properties').send(addressFor(0));
    expect(again.status).toBe(409);
    expect(await inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(properties))).toHaveLength(1);
    expect(await inCompany(t, t.seed.b.companyId, (tx) => tx.select().from(properties))).toHaveLength(1);
  });
});

describe('the database agrees', () => {
  // The routes above rely on the repositories; this reads the rows the way a repository bug would:
  // straight through withTenant as the wrong company.
  test("a company B context cannot read or change A's rows even with no WHERE clause on the company", async () => {
    const asB = <T>(fn: (tx: Tx) => Promise<T>) => inCompany(t, t.seed.b.companyId, fn);
    expect(await asB((tx) => tx.select().from(customers))).toEqual([]);
    expect(await asB((tx) => tx.select().from(properties))).toEqual([]);
    expect(await asB((tx) => tx.select().from(jobs))).toEqual([]);
    const changed = await asB((tx) => tx.update(jobs).set({ stage: 'won' }).returning({ id: jobs.id }));
    expect(changed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The approval routes (Task 14). Each row puts one of A's tasks in the state where A's own call
// succeeds, then sends B's owner the very same request (same URL, same body): B gets a 404, A's
// task is exactly as it was, and only then does A's call go through. So B's 404 is the lookup
// failing, never a state or body check that happened to come first.

type ApprovalCase = {
  method: 'GET' | 'PATCH' | 'POST';
  path: string;
  /** What A gets for the same call. */
  ok: 200 | 201;
  /** Puts a task of A's in the state the call needs; returns the ids for the path and the body to send. */
  prepare: () => Promise<{ taskId: string; stepId: string; body?: Record<string, unknown> }>;
};

/** A's demo plan (message, internal, spend) as a draft. */
async function aDraft() {
  const { taskId } = await newTask(t, 'a');
  return { taskId, steps: await dbSteps(t, 'a', taskId) };
}

const approvalCases: ApprovalCase[] = [
  {
    method: 'GET',
    path: '/api/approvals/:taskId',
    ok: 200,
    prepare: async () => {
      const { taskId, steps } = await aDraft();
      return { taskId, stepId: steps[0]!.id };
    },
  },
  {
    method: 'PATCH',
    path: '/api/approvals/:taskId/steps/:stepId',
    ok: 200,
    prepare: async () => {
      const { taskId, steps } = await aDraft();
      return { taskId, stepId: steps[0]!.id, body: { version: 1, enabled: false } };
    },
  },
  {
    method: 'POST',
    path: '/api/approvals/:taskId/approve',
    ok: 200,
    prepare: async () => {
      const { taskId, steps } = await aDraft();
      return { taskId, stepId: steps[0]!.id, body: seenOf(steps) };
    },
  },
  {
    method: 'POST',
    path: '/api/approvals/:taskId/decline',
    ok: 200,
    prepare: async () => {
      const { taskId, steps } = await aDraft();
      return { taskId, stepId: steps[0]!.id, body: { reason: 'Not this storm' } };
    },
  },
  {
    method: 'POST',
    path: '/api/approvals/:taskId/steps/:stepId/decline',
    ok: 200,
    prepare: async () => {
      const { taskId, steps } = await aDraft();
      await setTask(t, 'a', taskId, { status: 'awaiting_owner' });
      await setStep(t, 'a', steps[2]!.id, { status: 'awaiting_owner' });
      return { taskId, stepId: steps[2]!.id };
    },
  },
  {
    method: 'POST',
    path: '/api/approvals/:taskId/steps/:stepId/retry',
    ok: 200,
    prepare: async () => {
      const { taskId, steps } = await aDraft();
      await setTask(t, 'a', taskId, { status: 'needs_attention' });
      await setStep(t, 'a', steps[0]!.id, { status: 'needs_attention', attempts: 5 });
      return { taskId, stepId: steps[0]!.id };
    },
  },
  {
    method: 'POST',
    path: '/api/approvals/:taskId/rerun',
    ok: 201,
    prepare: async () => {
      const { taskId, steps } = await aDraft();
      await setTask(t, 'a', taskId, { status: 'expired' });
      return { taskId, stepId: steps[0]!.id };
    },
  },
];

const send = (agent: SuperAgent, c: ApprovalCase, url: string, body?: Record<string, unknown>) =>
  c.method === 'GET' ? agent.get(url) : c.method === 'PATCH' ? agent.patch(url).send(body ?? {}) : agent.post(url).send(body ?? {});

describe("company B's owner against company A's approval tasks", () => {
  test.each(approvalCases.map((c) => [`${c.method} ${c.path}`, c] as const))('%s → 404 for B, and A gets its answer', async (_name, c) => {
    const { taskId, stepId, body } = await c.prepare();
    const url = c.path.replace(':taskId', taskId).replace(':stepId', stepId);
    const tasksBefore = await inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(agentTasks).orderBy(agentTasks.id));
    const stepsBefore = await inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(agentTaskSteps).orderBy(agentTaskSteps.id));

    const res = await send(bOwner, c, url, body);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });

    expect(await inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(agentTasks).orderBy(agentTasks.id))).toEqual(tasksBefore);
    expect(await inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(agentTaskSteps).orderBy(agentTaskSteps.id))).toEqual(stepsBefore);
    expect(await inCompany(t, t.seed.b.companyId, (tx) => tx.select().from(agentTasks).orderBy(agentTasks.id))).toEqual([]);
    expect(await inCompany(t, t.seed.b.companyId, (tx) => tx.select().from(auditLog))).toEqual([]);
    expect(t.queue.calls).toEqual([]);

    const mine = await send(aOwner, c, url, body);
    expect(mine.status, JSON.stringify(mine.body)).toBe(c.ok);
    expect((await dbTask(t, 'a', taskId)).id).toBe(taskId);
  });

  test('the table covers every approval route that takes a task id', () => {
    expect(approvalCases.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/approvals/:taskId',
      'PATCH /api/approvals/:taskId/steps/:stepId',
      'POST /api/approvals/:taskId/approve',
      'POST /api/approvals/:taskId/decline',
      'POST /api/approvals/:taskId/steps/:stepId/decline',
      'POST /api/approvals/:taskId/steps/:stepId/retry',
      'POST /api/approvals/:taskId/rerun',
    ]);
  });
});
