import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppDeps } from '../src/app.ts';
import { MESSAGES } from '../src/errors.ts';
import { JOB_HANDLERS } from '../src/jobs/handlers.ts';
import { JOB_NAMES, type JobHandlers } from '../src/jobs/queue.ts';
import { SCHEDULES } from '../src/jobs/worker.ts';
import { builtInHandlers } from '../src/tasks/handlers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const STORM_JOBS = ['storm-match-company', 'storm-draft', 'storm-alert', 'ad-sync-company'] as const;

describe('the storm skeleton', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  test('GET /api/public/storm-requests/x is reachable without a session and answers the 404 stub', async () => {
    const res = await request(t.app).get('/api/public/storm-requests/x');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: MESSAGES.notFound });
  });

  test('POST /api/public/storm-requests/x without a session is not a 401', async () => {
    const res = await request(t.app).post('/api/public/storm-requests/x').send({});
    expect(res.status).not.toBe(401);
    // The real route validates the body before looking the page up, so an empty body is a 422.
    expect(res.status).toBe(422);
  });

  test('GET /u/x works without a session', async () => {
    const res = await request(t.app).get('/u/x');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
    expect(res.type).toBe('text/html');
  });

  test('POST /u/x works without a session', async () => {
    const res = await request(t.app).post('/u/x').send({});
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  test('storm-page passes through on the app host', async () => {
    const res = await request(t.app).get('/storm/abc');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  test('SCHEDULES gain the four storm schedules with exact crons', () => {
    const expected: [string, string][] = [
      ['spotter-sync', '*/30 * * * *'],
      ['storm-match', '*/10 * * * *'],
      ['ad-spend-sync', '0 * * * *'],
      ['hail-health', '*/15 * * * *'],
    ];
    for (const [name, cron] of expected) expect(SCHEDULES.find((s) => s.name === name)?.cron).toBe(cron);
  });

  test('JOB_NAMES gain the four storm queues', () => {
    for (const name of STORM_JOBS) expect(JOB_NAMES).toContain(name);
  });

  test('send_email_batch and build_routes are registered and create_ad_campaign still refuses', async () => {
    expect(builtInHandlers.send_email_batch).toBeDefined();
    expect(builtInHandlers.build_routes).toBeDefined();
    for (const type of ['create_ad_campaign'] as const) {
      const handler = builtInHandlers[type];
      expect(handler).toBeDefined();
      await expect(handler!({} as never, {} as never, {} as never)).rejects.toThrow('not yet');
    }
  });

  test('storm job handlers exist for every new job name', () => {
    for (const name of STORM_JOBS) expect(typeof JOB_HANDLERS[name]).toBe('function');
  });

  test('the storm-match-company job sent with singletonKey companyId is deduped while waiting', async () => {
    const companyId = '11111111-1111-4111-8111-111111111111';
    let runs = 0;
    const handlers: JobHandlers = {
      ...JOB_HANDLERS,
      'storm-match-company': async () => {
        runs++;
      },
    };
    await t.jobs.send('storm-match-company', { companyId }, { singletonKey: companyId });
    await t.jobs.send('storm-match-company', { companyId }, { singletonKey: companyId });
    expect(t.jobs.sent).toHaveLength(2);
    await t.jobs.drain({} as AppDeps, handlers);
    expect(runs).toBe(1);
  });
});
