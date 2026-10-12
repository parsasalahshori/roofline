import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { agentSettings } from '@roofline/db';
import { RUN_NOW } from '../src/agents/run-now.ts';
import { Actors, inCompany, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const MINUTE = 60_000;

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
  delete RUN_NOW.storm_scout;
});

const run = async (agent: string, who: 'owner' | 'office' | 'rep' = 'owner', company: 'a' | 'b' = 'a') =>
  (await actors.as(who, company)).post(`/api/agents/${agent}/run`).send({});

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

  test('claims scheduler and follow_up run now are 409', async () => {
    for (const agent of ['claims', 'scheduler', 'follow_up']) {
      const res = await run(agent);
      expect(res.status).toBe(409);
    }
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
