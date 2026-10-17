import { createHash } from 'node:crypto';
import type { ProposalView, PublicProposalView } from '@roofline/shared';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { companies, companySettings, customers, measurements, proposalEvents, proposals } from '@roofline/db';
import { addressFor, Actors, dbActivities, inCompany, mustCreate } from './crm-helpers.ts';
import { proposalIpHashFor } from '../src/public/proposal-common.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DAYTIME } from './sms-helpers.ts';
import { dbSteps, seenOf } from './task-helpers.ts';

// The homeowner's public proposal link (E1 Task 12). DB-backed: runs on CI (Platform), never locally without Docker.

let t: TestApp;
let who: Actors;

const TOKEN_PATTERN = /\/p\/([A-Za-z0-9_-]+)/;
const PHONE = '+14025550101';

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(DAYTIME);
});

afterEach(async () => {
  await t.close();
});

/** A sent proposal for a fresh job; returns its token and ids. */
async function sent() {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
  const [m] = await inCompany(t, t.seed.a.companyId, (tx) =>
    tx
      .insert(measurements)
      .values({ companyId: t.seed.a.companyId, propertyId: property.id, jobId: job.id, kind: 'estimate', method: 'outline', surfaceSqFt: 2400, pitchX12: 6, edgeFt: 220, ridgeFt: 60, valleyFt: 20 })
      .returning({ id: measurements.id }),
  );
  await inCompany(t, t.seed.a.companyId, (tx) =>
    tx.update(customers).set({ phones: [{ e164: PHONE, label: 'mobile', primary: true }], smsConsentStatus: 'express' }).where(eq(customers.id, customer.id)),
  );
  const made = await owner.post('/api/proposals').send({ measurementId: m!.id });
  expect(made.status).toBe(201);
  const proposal = made.body as ProposalView;
  const ask = await owner.post(`/api/proposals/${proposal.id}/send`);
  expect(ask.status).toBe(201);
  const taskId = ask.body.taskId as string;
  const approve = await owner.post(`/api/approvals/${taskId}/approve`).send(seenOf(await dbSteps(t, 'a', taskId)));
  expect(approve.status).toBe(200);
  await t.queue.drain(t.deps);
  const match = TOKEN_PATTERN.exec(t.sms.sent[0]!.body);
  expect(match).not.toBeNull();
  return { owner, job, proposal, token: match![1]! };
}

const origin = () => t.deps.config.APP_ORIGIN;
const proposalRow = (id: string) =>
  inCompany(t, t.seed.a.companyId, async (tx) => (await tx.select().from(proposals).where(eq(proposals.id, id)))[0]!);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_WORKING = "This proposal link doesn't work.";
const get = (token: string) => request(t.app).get(`/api/public/proposals/${token}`);
const postTo = (token: string, path: string, body: Record<string, unknown> = {}) =>
  request(t.app).post(`/api/public/proposals/${token}${path}`).set('Origin', origin()).send(body);
const events = (id: string, kind: 'viewed' | 'option_viewed') =>
  inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(proposalEvents).where(and(eq(proposalEvents.proposalId, id), eq(proposalEvents.kind, kind))));

describe('reading the link', () => {
  test('an unknown token is a 404 with no hint, signed out or in another company', async () => {
    await sent();
    const guess = 'A'.repeat(43);
    const res = await get(guess);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_WORKING });
    const other = await who.as('owner', 'b');
    const again = await other.get(`/api/public/proposals/${guess}`);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: NOT_WORKING });
    expect((await get('short')).body).toEqual({ error: NOT_WORKING });
  });

  test('the token answers the homeowner view without a session, with no prices or customer ids, and the no-store headers', async () => {
    const s = await sent();
    const res = await get(s.token);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    const view = res.body as PublicProposalView;
    expect(view.status).toBe('open');
    expect(view.options.length).toBeGreaterThan(0);
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/unitPrice|unit_price|customerId|propertyId|jobId|companyId/);
    expect(text).not.toContain(s.proposal.id);
  });

  test("the view carries the company's brand colour and logo, null when it has none, and each company sees only its own", async () => {
    const s = await sent();
    expect((await get(s.token)).body).toMatchObject({ accentColor: null, logoUrl: null });
    await inCompany(t, t.seed.a.companyId, async (tx) => {
      await tx.update(companySettings).set({ quoteAccentColor: '#ED3A2B' }).where(eq(companySettings.companyId, t.seed.a.companyId));
      await tx.update(companies).set({ logoUrl: 'https://cdn.example.test/logo.png' }).where(eq(companies.id, t.seed.a.companyId));
    });
    const branded = (await get(s.token)).body as PublicProposalView;
    expect(branded.accentColor).toBe('#ED3A2B');
    expect(branded.logoUrl).toBe('https://cdn.example.test/logo.png');
    // Company B's settings are untouched, so B's own proposal link would still be the default
    const other = await inCompany(t, t.seed.b.companyId, (tx) =>
      tx.select({ accent: companySettings.quoteAccentColor }).from(companySettings).where(eq(companySettings.companyId, t.seed.b.companyId)),
    );
    expect(other[0]?.accent ?? null).toBeNull();
  });

  test('after valid_until it is readable as expired; 30 days later it is gone (410 with the phone)', async () => {
    const s = await sent();
    const { validUntil } = (await get(s.token)).body as PublicProposalView;
    t.clock.set(new Date(`${validUntil}T12:00:00.000Z`));
    t.clock.advance(2 * DAY_MS);
    const expired = await get(s.token);
    expect(expired.status).toBe(200);
    expect(expired.body.status).toBe('expired');
    t.clock.advance(31 * DAY_MS);
    const gone = await get(s.token);
    expect(gone.status).toBe(410);
    expect(Object.keys(gone.body).sort()).toEqual(['companyPhone', 'error']);
  });

  test('a replaced proposal is gone (410)', async () => {
    const s = await sent();
    await inCompany(t, t.seed.a.companyId, (tx) => tx.update(proposals).set({ status: 'replaced' }).where(eq(proposals.id, s.proposal.id)));
    const res = await get(s.token);
    expect(res.status).toBe(410);
    expect(res.body).toHaveProperty('companyPhone');
  });

  test('the signed copy is a 404 until it is ready', async () => {
    const s = await sent();
    expect((await get(`${s.token}/signed.pdf`)).status).toBe(404);
  });
});

describe('views and decline', () => {
  test('two views count twice, set viewed once, and leave one "opened the proposal" activity', async () => {
    const s = await sent();
    expect((await postTo(s.token, '/view')).status).toBe(204);
    const first = await proposalRow(s.proposal.id);
    expect(first.status).toBe('viewed');
    expect(first.viewCount).toBe(1);
    expect(first.firstViewedAt).not.toBeNull();
    t.clock.advance(60_000);
    expect((await postTo(s.token, '/view')).status).toBe(204);
    const second = await proposalRow(s.proposal.id);
    expect(second.viewCount).toBe(2);
    expect(second.firstViewedAt?.getTime()).toBe(first.firstViewedAt?.getTime());
    const opened = (await dbActivities(t, t.seed.a.companyId, s.job.id)).filter((a) => a.summary.includes('opened the proposal'));
    expect(opened).toHaveLength(1);
    expect(await events(s.proposal.id, 'viewed')).toHaveLength(2);
  });

  test('a view with an option records option_viewed', async () => {
    const s = await sent();
    const view = (await get(s.token)).body as PublicProposalView;
    const optionId = view.options[0]!.id;
    expect((await postTo(s.token, '/view', { optionId })).status).toBe(204);
    const rows = await events(s.proposal.id, 'option_viewed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ optionId });
  });

  test('a view stores a keyed hash of the address, never the unkeyed sha256 (security finding 8)', async () => {
    const s = await sent();
    expect((await postTo(s.token, '/view')).status).toBe(204);
    const [row] = await events(s.proposal.id, 'viewed');
    const companyId = t.seed.a.companyId;
    // supertest connects over loopback; req.ip is one of these depending on the platform.
    const candidates = ['::ffff:127.0.0.1', '127.0.0.1', '::1'];
    expect(row!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(candidates.map((ip) => proposalIpHashFor(t.deps.config, ip, companyId))).toContain(row!.ipHash);
    for (const ip of candidates) {
      expect(row!.ipHash).not.toBe(createHash('sha256').update(`${ip}${companyId}`).digest('hex'));
    }
  });

  test('decline stores the reason; a reason over 500 characters is a 400', async () => {
    const s = await sent();
    expect((await postTo(s.token, '/decline', { reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await proposalRow(s.proposal.id)).status).not.toBe('declined');
    expect((await postTo(s.token, '/decline', { reason: 'Too much for us.' })).status).toBe(204);
    const row = await proposalRow(s.proposal.id);
    expect(row.status).toBe('declined');
    expect(row.declineReason).toBe('Too much for us.');
  });
});

describe('same-origin posts and read-only companies', () => {
  test('a post with the app origin works; one from another origin is a 403', async () => {
    const s = await sent();
    expect((await postTo(s.token, '/view')).status).toBe(204);
    const evil = await request(t.app).post(`/api/public/proposals/${s.token}/view`).set('Origin', 'https://evil.example').send({});
    expect(evil.status).toBe(403);
    const evilSign = await request(t.app).post(`/api/public/proposals/${s.token}/sign`).set('Origin', 'https://evil.example').send({});
    expect(evilSign.status).toBe(403);
    const evilDecline = await request(t.app).post(`/api/public/proposals/${s.token}/decline`).set('Origin', 'https://evil.example').send({});
    expect(evilDecline.status).toBe(403);
  });

  test('a homeowner of a trial-ended company can still read and sign', async () => {
    const s = await sent();
    await t.deps.pools.system.$client.query("update companies set status = 'trial_ended' where id = $1", [t.seed.a.companyId]);
    const view = await get(s.token);
    expect(view.status).toBe(200);
    const optionId = (view.body as PublicProposalView).options[0]!.id;
    const res = await postTo(s.token, '/sign', { optionId, consent: true, signerName: 'Molly Lindgren', typedSignature: 'Molly Lindgren' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signed: true });
  });
});

describe('the per-link limit', () => {
  test('one link gets 120 requests an hour across open, view, decline and the signed copy, from any address; the 121st is a 429', async () => {
    const s = await sent();
    // Behind a proxy, so each request can come from its own address and the per-IP limit never trips.
    t.app.set('trust proxy', 1);
    const from = (i: number) => `198.51.100.${i % 200}`;
    for (let i = 0; i < 120; i += 1) {
      const res =
        i % 2 === 0
          ? await request(t.app).get(`/api/public/proposals/${s.token}`).set('X-Forwarded-For', from(i))
          : await request(t.app).post(`/api/public/proposals/${s.token}/view`).set('Origin', origin()).set('X-Forwarded-For', from(i)).send({});
      expect(res.status, `request ${i + 1}`).toBeLessThan(400);
    }
    for (const res of [
      await request(t.app).get(`/api/public/proposals/${s.token}`).set('X-Forwarded-For', '203.0.113.200'),
      await request(t.app).get(`/api/public/proposals/${s.token}/signed.pdf`).set('X-Forwarded-For', '203.0.113.201'),
      await request(t.app).post(`/api/public/proposals/${s.token}/decline`).set('Origin', origin()).set('X-Forwarded-For', '203.0.113.202').send({}),
    ]) {
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: "You're going a little fast. Try again in a minute." });
    }
    expect((await proposalRow(s.proposal.id)).status).not.toBe('declined');
  });
});
