import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { attachRelayUpgrade } from '../src/front-desk/relay-server.ts';
import { JOB_HANDLERS } from '../src/jobs/handlers.ts';
import { InlineJobs, JOB_NAMES } from '../src/jobs/queue.ts';
import { SCHEDULES } from '../src/jobs/worker.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const FD_JOBS = ['fd-after-call', 'fd-recording-store', 'fd-text', 'fd-forwarding-test'] as const;
const WAIT_MS = 5000;

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(() => undefined);

describe('Front Desk skeleton', () => {
  test('JOB_NAMES gain the Front Desk names before the G1 names', () => {
    expect(JOB_NAMES.slice(0, 2)).toEqual(['import-customers', 'texting-registration']);
    // G1 appends seven agent jobs after the Front Desk names.
    expect(JOB_NAMES.slice(-11, -7)).toEqual([...FD_JOBS]);
    for (const name of JOB_NAMES) expect(typeof JOB_HANDLERS[name]).toBe('function');
  });

  test('SCHEDULES gain fd-retention and fd-health with their crons', () => {
    expect(SCHEDULES.slice(-7, -5).map((s) => [s.name, s.cron])).toEqual([
      ['fd-retention', '47 3 * * *'],
      ['fd-health', '*/2 * * * *'],
    ]);
  });

  test('InlineJobs records startAfter and singletonKey for a Front Desk job', async () => {
    const jobs = new InlineJobs();
    const data = { companyId: '11111111-1111-4111-8111-111111111111', conversationId: 'c-1' };
    await jobs.send('fd-text', data, { singletonKey: 'c-1', startAfter: 20 });
    expect(jobs.sent[0]).toEqual({ name: 'fd-text', data, singletonKey: 'c-1', startAfter: 20 });
  });

  test.each(['/hooks/twilio/voice', '/hooks/twilio/voice-status'])('%s is reachable without a session and answers 404 for an unknown number', async (path) => {
    const res = await request(t.app)
      .post(path)
      .type('form')
      .set('X-Twilio-Signature', 'not-checked-before-routing')
      .send({ CallSid: 'CA1', To: '+14025559999' });
    expect(res.status).toBe(404);
  });

  test.each(['/hooks/twilio/voice', '/hooks/twilio/voice-status'])('%s refuses a request with no signature before any lookup', async (path) => {
    const res = await request(t.app).post(path).type('form').send({ CallSid: 'CA1', To: '+14025559999' });
    expect(res.status).toBe(403);
  });

  test('the /api stubs sit behind the session gate', async () => {
    for (const path of ['/api/conversations', '/api/front-desk', '/api/calls', '/api/blocked-numbers', '/api/me/transfer-phone']) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(401);
    }
  });

  test('the /relay upgrade closes with 1008 and any other upgrade path is refused', async () => {
    const server = http.createServer(t.app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const relay = attachRelayUpgrade(server, t.deps);
    const port = (server.address() as AddressInfo).port;
    const clients: WebSocket[] = [];
    try {
      const good = new WebSocket(`ws://127.0.0.1:${port}/relay`);
      clients.push(good);
      const [code] = (await Promise.race([
        once(good, 'close'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay close timed out')), WAIT_MS)),
      ])) as [number];
      expect(code).toBe(1008);

      const bad = new WebSocket(`ws://127.0.0.1:${port}/other`);
      clients.push(bad);
      let opened = false;
      bad.on('open', () => {
        opened = true;
      });
      await Promise.race([
        once(bad, 'error'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('refusal timed out')), WAIT_MS)),
      ]);
      expect(opened).toBe(false);
    } finally {
      for (const c of clients) c.terminate();
      relay.close();
      server.close();
    }
  });
});
