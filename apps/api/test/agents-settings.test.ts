import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentSettings, agentTaskSteps, isAgentPaused, timeBaselines } from '@roofline/db';
import { TIME_BASELINES, VISIBLE_BASELINE_KEYS } from '@roofline/shared';
import { Actors, type CompanyKey, dbAudit, inCompany, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps, newTask, NOT_ALLOWED } from './task-helpers.ts';

const BASELINES = '/api/agents/time-baselines';
const MINUTES_MESSAGE = 'Please enter minutes from 0 to 600, in steps of half a minute.';

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  actors = new Actors(t);
});

const companyId = (c: CompanyKey) => t.seed[c].companyId;
const overrideRows = (c: CompanyKey) => inCompany(t, companyId(c), (tx) => tx.select().from(timeBaselines));
const paused = (c: CompanyKey, agent: 'storm_scout' | 'estimator' | 'front_desk') =>
  inCompany(t, companyId(c), (tx) => isAgentPaused(tx, { companyId: companyId(c), userId: null, role: 'system', canApproveSpend: false }, agent));

type Row = { key: string; minutes: number; defaultMinutes: number };

describe('GET time-baselines', () => {
  test('GET time-baselines lists the visible baselines with defaults for the owner and canEdit true', async () => {
    const owner = await actors.as('owner');
    const res = await owner.get(BASELINES);
    expect(res.status).toBe(200);
    expect(res.body.canEdit).toBe(true);
    expect(res.body.hourlyRateCents).toBe(2800);
    expect((res.body.rows as Row[]).map((r) => r.key)).toEqual([...VISIBLE_BASELINE_KEYS]);
    const text = (res.body.rows as Row[]).find((r) => r.key === 'text_sent')!;
    expect(text.minutes).toBe(TIME_BASELINES.text_sent.minutes);
    expect(text.defaultMinutes).toBe(TIME_BASELINES.text_sent.minutes);
  });

  test('GET time-baselines for office has canEdit false', async () => {
    const office = await actors.as('office');
    const res = await office.get(BASELINES);
    expect(res.status).toBe(200);
    expect(res.body.canEdit).toBe(false);
  });

  test('GET time-baselines is 403 for a rep', async () => {
    const rep = await actors.as('rep');
    const res = await rep.get(BASELINES);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NOT_ALLOWED);
  });

  test('GET time-baselines never lists the hidden demo key', async () => {
    const owner = await actors.as('owner');
    const res = await owner.get(BASELINES);
    expect((res.body.rows as Row[]).some((r) => r.key === 'demo')).toBe(false);
  });
});

describe('PUT time-baselines', () => {
  test('PUT time-baselines sets an override that GET then returns', async () => {
    const owner = await actors.as('owner');
    const put = await owner.put(BASELINES).send({ minutes: { text_sent: 2.5 } });
    expect(put.status).toBe(200);
    expect((put.body.rows as Row[]).find((r) => r.key === 'text_sent')!.minutes).toBe(2.5);
    const get = await owner.get(BASELINES);
    const row = (get.body.rows as Row[]).find((r) => r.key === 'text_sent')!;
    expect(row.minutes).toBe(2.5);
    expect(row.defaultMinutes).toBe(TIME_BASELINES.text_sent.minutes);
  });

  test('PUT time-baselines null resets a key to its default (override row deleted)', async () => {
    const owner = await actors.as('owner');
    await owner.put(BASELINES).send({ minutes: { text_sent: 4 } });
    expect(await overrideRows('a')).toHaveLength(1);
    const res = await owner.put(BASELINES).send({ minutes: { text_sent: null } });
    expect(res.status).toBe(200);
    expect(await overrideRows('a')).toHaveLength(0);
    expect((res.body.rows as Row[]).find((r) => r.key === 'text_sent')!.minutes).toBe(TIME_BASELINES.text_sent.minutes);
  });

  test('PUT time-baselines is owner only: office and rep get 403', async () => {
    for (const who of ['office', 'rep'] as const) {
      const agent = await actors.as(who);
      const res = await agent.put(BASELINES).send({ minutes: { text_sent: 3 } });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(NOT_ALLOWED);
    }
    expect(await overrideRows('a')).toHaveLength(0);
  });

  test('PUT time-baselines rejects 0.25 steps, negatives, 601, and strings with a plain message', async () => {
    const owner = await actors.as('owner');
    for (const bad of [0.25, -1, 601, '3', Number.NaN, {}, true]) {
      const res = await owner.put(BASELINES).send({ minutes: { text_sent: bad } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(MINUTES_MESSAGE);
    }
    expect(await overrideRows('a')).toHaveLength(0);
  });

  test('PUT time-baselines rejects unknown and hidden keys with 400', async () => {
    const owner = await actors.as('owner');
    for (const key of ['demo', 'nonsense']) {
      const res = await owner.put(BASELINES).send({ minutes: { [key]: 3 } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`We don't have a time setting called "${key}".`);
    }
    const noMinutes = await owner.put(BASELINES).send({});
    expect(noMinutes.status).toBe(400);
    expect(await overrideRows('a')).toHaveLength(0);
  });

  test('PUT time-baselines writes an audit entry', async () => {
    const owner = await actors.as('owner');
    await owner.put(BASELINES).send({ minutes: { text_sent: 3 } });
    const rows = await dbAudit(t, companyId('a'), 'agents.baselines.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(actors.user('owner').userId);
    expect(rows[0]!.after).toEqual({ text_sent: 3 });
    expect(rows[0]!.before).toEqual({ text_sent: TIME_BASELINES.text_sent.minutes });
  });

  test('PUT time-baselines in company A does not change company B', async () => {
    const owner = await actors.as('owner');
    await owner.put(BASELINES).send({ minutes: { text_sent: 9 } });
    const ownerB = await actors.as('owner', 'b');
    const res = await ownerB.get(BASELINES);
    expect((res.body.rows as Row[]).find((r) => r.key === 'text_sent')!.minutes).toBe(TIME_BASELINES.text_sent.minutes);
    expect(await overrideRows('b')).toHaveLength(0);
  });
});

describe('pause', () => {
  test('pause is owner only and sets paused_at and paused_by', async () => {
    for (const who of ['office', 'rep'] as const) {
      const res = await (await actors.as(who)).put('/api/agents/storm_scout/paused').send({ paused: true });
      expect(res.status).toBe(403);
    }
    expect(await paused('a', 'storm_scout')).toBe(false);
    const owner = await actors.as('owner');
    const res = await owner.put('/api/agents/storm_scout/paused').send({ paused: true });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(true);
    expect(typeof res.body.pausedAt).toBe('string');
    const [row] = await inCompany(t, companyId('a'), (tx) => tx.select().from(agentSettings).where(eq(agentSettings.agent, 'storm_scout')));
    expect(row!.pausedAt).not.toBeNull();
    expect(row!.pausedBy).toBe(actors.user('owner').userId);
    expect(await dbAudit(t, companyId('a'), 'agents.pause')).toHaveLength(1);
  });

  test('resume clears the pause', async () => {
    const owner = await actors.as('owner');
    await owner.put('/api/agents/estimator/paused').send({ paused: true });
    const res = await owner.put('/api/agents/estimator/paused').send({ paused: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paused: false, pausedAt: null });
    const [row] = await inCompany(t, companyId('a'), (tx) => tx.select().from(agentSettings).where(eq(agentSettings.agent, 'estimator')));
    expect(row!.pausedAt).toBeNull();
    expect(row!.pausedBy).toBeNull();
    expect(await dbAudit(t, companyId('a'), 'agents.resume')).toHaveLength(1);
  });

  test('isAgentPaused is false with no row, true after pausing, false after resuming', async () => {
    const owner = await actors.as('owner');
    expect(await paused('a', 'front_desk')).toBe(false);
    await owner.put('/api/agents/front_desk/paused').send({ paused: true });
    expect(await paused('a', 'front_desk')).toBe(true);
    await owner.put('/api/agents/front_desk/paused').send({ paused: false });
    expect(await paused('a', 'front_desk')).toBe(false);
  });

  test('pausing a G1 agent is 409', async () => {
    const owner = await actors.as('owner');
    for (const agent of ['claims', 'scheduler', 'follow_up']) {
      const res = await owner.put(`/api/agents/${agent}/paused`).send({ paused: true });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('This agent is coming soon.');
    }
  });

  test('pausing an unknown agent is 404', async () => {
    const owner = await actors.as('owner');
    for (const agent of ['nobody', NO_UUID, 'system']) {
      const res = await owner.put(`/api/agents/${agent}/paused`).send({ paused: true });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(NOT_FOUND);
    }
  });

  test('pausing in company A leaves company B on', async () => {
    const owner = await actors.as('owner');
    await owner.put('/api/agents/storm_scout/paused').send({ paused: true });
    expect(await paused('a', 'storm_scout')).toBe(true);
    expect(await paused('b', 'storm_scout')).toBe(false);
  });

  test('pausing does not change a running task', async () => {
    const { taskId } = await newTask(t, 'a');
    const steps = await dbSteps(t, 'a', taskId);
    const stepId = steps[0]!.id;
    await inCompany(t, companyId('a'), (tx) => tx.update(agentTaskSteps).set({ status: 'running' }).where(eq(agentTaskSteps.id, stepId)));
    const owner = await actors.as('owner');
    const res = await owner.put('/api/agents/storm_scout/paused').send({ paused: true });
    expect(res.status).toBe(200);
    const [after] = await inCompany(t, companyId('a'), (tx) => tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.id, stepId)));
    expect(after!.status).toBe('running');
  });
});
