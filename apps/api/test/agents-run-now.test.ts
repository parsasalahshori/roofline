import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { agentSettings, claimRunNow, isAgentPaused, setPaused } from '@roofline/db';
import type { Agent } from '@roofline/shared';
import { RUN_NOW } from '../src/agents/run-now.ts';
import { Actors, inCompany, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const MINUTE = 60_000;

const original = RUN_NOW.storm_scout;

let t: TestApp;
let actors: Actors;
let handler: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  t = await makeTestApp();
  actors = new Actors(t);
  handler = vi.fn(async () => {});
  RUN_NOW.storm_scout = handler as never;
});

afterEach(() => {
  RUN_NOW.storm_scout = original;
});

const run = async (agent: string, who: 'owner' | 'office' | 'rep' = 'owner', company: 'a' | 'b' = 'a') =>
  (await actors.as(who, company)).post(`/api/agents/${agent}/run`).send({});

const ctxOf = (company: 'a' | 'b' = 'a') => ({ companyId: t.seed[company].companyId, userId: null, role: 'system' as const, canApproveSpend: false });
const turnOn = (agent: Agent, company: 'a' | 'b' = 'a') =>
  inCompany(t, t.seed[company].companyId, (tx) => setPaused(tx, ctxOf(company), agent, false, t.clock.now()));
const pausedNow = (agent: Agent, company: 'a' | 'b' = 'a') =>
  inCompany(t, t.seed[company].companyId, (tx) => isAgentPaused(tx, ctxOf(company), agent));

const claimed = (company: 'a' | 'b' = 'a') =>
  inCompany(t, t.seed[company].companyId, (tx) => tx.select().from(agentSettings)).then((rows) =>
    rows.filter((r) => r.agent === 'storm_scout' && r.lastRunNowAt !== null),
  );

describe('POST /api/agents/:agent/run', () => {
  test('run now starts Storm Scout and returns 202 with the next allowed time five minutes out', async () => {
    const res = await run('storm_scout');
    expect(res.status).toBe(202);
    expect(res.body.started).toBe(true);
    expect(new Date(res.body.nextAllowedAt).getTime()).toBe(t.clock.now().getTime() + 5 * MINUTE);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('a second run within five minutes is 409 with a plain sentence', async () => {
    expect((await run('storm_scout')).status).toBe(202);
    t.clock.advance(MINUTE);
    const res = await run('storm_scout');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('You just ran this. You can run it again in 4 minutes.');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('run now is allowed again after five minutes (advance the test clock t.clock)', async () => {
    expect((await run('storm_scout')).status).toBe(202);
    t.clock.advance(5 * MINUTE + 1000);
    expect((await run('storm_scout')).status).toBe(202);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('two concurrent run now calls start exactly one run', async () => {
    const [x, y] = await Promise.all([run('storm_scout'), run('storm_scout')]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('estimator run now is 409 This agent works when you ask.', async () => {
    const res = await run('estimator');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This agent works when you ask.');
  });

  test('front desk run now is 409 Front Desk answers calls as they come in.', async () => {
    const res = await run('front_desk');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Front Desk answers calls as they come in.');
  });

  test.each(['claims', 'scheduler', 'follow_up'] as const)('%s run now while paused is 409 Turn this agent on first. and sends nothing', async (agent) => {
    const res = await run(agent);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Turn this agent on first.');
    expect(t.jobs.sent).toEqual([]);
    expect(await pausedNow(agent)).toBe(true);
  });

  test.each([
    ['claims', 'claims-daily'],
    ['scheduler', 'scheduler-reminders'],
    ['follow_up', 'followup-daily'],
  ] as const)('%s run now after turning on is 202 and sends %s for the company', async (agent, jobName) => {
    await turnOn(agent);
    const res = await run(agent);
    expect(res.status).toBe(202);
    expect(res.body.started).toBe(true);
    expect(new Date(res.body.nextAllowedAt).getTime()).toBe(t.clock.now().getTime() + 5 * MINUTE);
    const companyId = t.seed.a.companyId;
    expect(t.jobs.sent).toEqual([{ name: jobName, data: { companyId }, singletonKey: `run-now:${agent}:${companyId}` }]);
    expect(await pausedNow(agent)).toBe(false);
  });

  test('a second G1 run within five minutes is 409 and sends no second job', async () => {
    await turnOn('claims');
    expect((await run('claims')).status).toBe(202);
    t.clock.advance(MINUTE);
    const res = await run('claims');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('You just ran this. You can run it again in 4 minutes.');
    expect(t.jobs.sent).toHaveLength(1);
  });

  test('claimRunNow leaves a fresh G1 agent paused and a fresh launch agent on', async () => {
    for (const agent of ['claims', 'scheduler', 'follow_up'] as const) {
      const result = await inCompany(t, t.seed.a.companyId, (tx) => claimRunNow(tx, ctxOf(), agent, t.clock.now()));
      expect(result.claimed).toBe(true);
      expect(await pausedNow(agent), agent).toBe(true);
    }
    for (const agent of ['storm_scout', 'estimator', 'front_desk'] as const) {
      const result = await inCompany(t, t.seed.a.companyId, (tx) => claimRunNow(tx, ctxOf(), agent, t.clock.now()));
      expect(result.claimed).toBe(true);
      expect(await pausedNow(agent), agent).toBe(false);
    }
  });

  test('claimRunNow never changes an existing G1 row: a turned-on agent stays on', async () => {
    await turnOn('scheduler');
    await inCompany(t, t.seed.a.companyId, (tx) => claimRunNow(tx, ctxOf(), 'scheduler', t.clock.now()));
    expect(await pausedNow('scheduler')).toBe(false);
  });

  test('storm scout without a registered handler is 409 Storm Scout can check for hail once storm alerts are set up.', async () => {
    delete RUN_NOW.storm_scout;
    const res = await run('storm_scout');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Storm Scout can check for hail once storm alerts are set up.');
    expect(await claimed()).toHaveLength(0);
  });

  test('unknown agent is 404', async () => {
    for (const agent of ['nobody', 'system', NO_UUID]) {
      const res = await run(agent);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(NOT_FOUND);
    }
  });

  test('a rep cannot run now (403 Your role can\'t do that. Ask the owner.)', async () => {
    const res = await run('storm_scout', 'rep');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NOT_ALLOWED);
    expect(handler).not.toHaveBeenCalled();
  });

  test('office can run now', async () => {
    expect((await run('storm_scout', 'office')).status).toBe(202);
  });

  test('run now limit is per company: company B can still run after company A did', async () => {
    expect((await run('storm_scout', 'owner', 'a')).status).toBe(202);
    expect((await run('storm_scout', 'owner', 'a')).status).toBe(409);
    expect((await run('storm_scout', 'owner', 'b')).status).toBe(202);
    expect(await claimed('b')).toHaveLength(1);
  });
});

describe('Storm Scout run now (real handler)', () => {
  beforeEach(() => {
    RUN_NOW.storm_scout = original;
  });

  const matchSends = () => t.jobs.sent.filter((j) => j.name === 'storm-match-company');

  test('run now queues one storm-match-company job for the company', async () => {
    const res = await run('storm_scout');
    expect(res.status).toBe(202);
    const sends = matchSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.data).toEqual({ companyId: t.seed.a.companyId });
    expect(sends[0]?.singletonKey).toBe(t.seed.a.companyId);
  });

  test('a second run within five minutes is 409 and queues nothing more', async () => {
    expect((await run('storm_scout')).status).toBe(202);
    t.clock.advance(MINUTE);
    const res = await run('storm_scout');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('You just ran this. You can run it again in 4 minutes.');
    expect(matchSends()).toHaveLength(1);
  });

  test('two concurrent run now calls queue exactly one job', async () => {
    const [x, y] = await Promise.all([run('storm_scout'), run('storm_scout')]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    expect(matchSends()).toHaveLength(1);
  });
});

describe('run now: pause and commit order', () => {
  beforeEach(() => {
    RUN_NOW.storm_scout = original;
  });

  const matchSends = () => t.jobs.sent.filter((j) => j.name === 'storm-match-company');

  test('a paused Storm Scout is 409 Storm Scout is paused., sends no job and does not claim the slot', async () => {
    const owner = await actors.as('owner');
    expect((await owner.put('/api/agents/storm_scout/paused').send({ paused: true })).status).toBe(200);
    const res = await run('storm_scout');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Storm Scout is paused.');
    expect(matchSends()).toHaveLength(0);
    expect(await claimed()).toHaveLength(0);
  });

  test('a successful run sends exactly one job, after the claim has committed', async () => {
    const res = await run('storm_scout');
    expect(res.status).toBe(202);
    expect(matchSends()).toHaveLength(1);
    expect(await claimed()).toHaveLength(1);
  });
});
