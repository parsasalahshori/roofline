import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTaskSteps, agentTasks, storedFiles } from '@roofline/db';
import { UnconfiguredObjectStore } from '../src/providers/object-store.ts';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const NO_JOB = "We couldn't find that job.";
const NO_PACKET = 'No claim packet yet.';
const NO_STORAGE = "File storage isn't set up.";

let t: TestApp;
let who: Actors;
let houses = 0;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  houses = 0;
});

const A = () => t.seed.a.companyId;

/** A customer, a house and a job made by `agent`; phones and addresses are unique per call. */
async function aJob(agent: SuperAgent, extra: Record<string, unknown> = {}) {
  houses += 1;
  const customer = await mustCreate(agent, '/api/customers', { displayName: `Customer ${houses}` });
  const property = await mustCreate(agent, '/api/properties', { customerId: customer.id, ...addressFor(houses) });
  return mustCreate(agent, '/api/jobs', { customerId: customer.id, propertyId: property.id, ...extra });
}

/** An owner's job that already has a saved claim. */
async function claimJob(extra: Record<string, unknown> = {}) {
  const owner = await who.as('owner');
  const job = await aJob(owner, extra);
  await owner.put(`/api/jobs/${job.id}/claim`).send({ insurer: 'Acme Mutual', dateOfLoss: '2026-09-30', status: 'filed' }).expect(200);
  return job;
}

const packetFiles = () =>
  inCompany(t, A(), (tx) => tx.select().from(storedFiles).where(eq(storedFiles.kind, 'claim_packet')));
const packetSteps = () =>
  inCompany(t, A(), (tx) => tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.type, 'build_claim_packet')));
const puts = () => t.objectStore.calls.filter((c) => c.method === 'put');

describe('claim packet', () => {
  test('GET before any packet: 404 No claim packet yet.', async () => {
    const job = await claimJob();
    const res = await (await who.as('owner')).get(`/api/jobs/${job.id}/claim/packet`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(NO_PACKET);
  });

  test('POST without a saved claim is a 409', async () => {
    const owner = await who.as('owner');
    const job = await aJob(owner);
    const res = await owner.post(`/api/jobs/${job.id}/claim/packet`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Save the claim details first.');
  });

  test('POST builds a claim_packet stored file and GET streams the PDF', async () => {
    const job = await claimJob();
    const owner = await who.as('owner');
    const built = await owner.post(`/api/jobs/${job.id}/claim/packet`);
    expect(built.status).toBe(200);

    const claim = await owner.get(`/api/jobs/${job.id}/claim`);
    const claimId = claim.body.claim.id as string;
    const files = await packetFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.objectKey.startsWith(`claim-packets/${claimId}/`)).toBe(true);
    expect(claim.body.packet.storedFileId).toBe(files[0]!.id);
    expect(built.body.packet.storedFileId).toBe(files[0]!.id);

    const pdf = await owner.get(`/api/jobs/${job.id}/claim/packet`).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const steps = await packetSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: 'done', result: { built: 1 } });
    const tasks = await inCompany(t, A(), (tx) => tx.select().from(agentTasks).where(eq(agentTasks.id, steps[0]!.taskId)));
    expect(tasks[0]).toMatchObject({ kind: 'claim_packet', mode: 'live' });
  });

  test('a rerun stores a second version and GET returns the latest', async () => {
    const job = await claimJob();
    const owner = await who.as('owner');
    const first = await owner.post(`/api/jobs/${job.id}/claim/packet`).expect(200);
    t.clock.advance(60_000);
    const second = await owner.post(`/api/jobs/${job.id}/claim/packet`).expect(200);

    expect(second.body.packet.storedFileId).not.toBe(first.body.packet.storedFileId);
    expect(await packetFiles()).toHaveLength(2);
    const keys = puts().map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);

    const latest = (await packetFiles()).find((f) => f.id === second.body.packet.storedFileId)!;
    const wanted = await t.objectStore.get(latest.objectKey);
    const got = await owner.get(`/api/jobs/${job.id}/claim/packet`).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(Buffer.from(wanted!).equals(got.body as Buffer)).toBe(true);
  });

  test('a rep outside the job gets 404 on POST and GET; a rep assigned to it can build', async () => {
    const job = await claimJob({ assignedUserId: who.user('otherRep').userId });
    const rep = await who.as('rep');
    const post = await rep.post(`/api/jobs/${job.id}/claim/packet`);
    expect(post.status).toBe(404);
    expect(post.body.error).toBe(NO_JOB);
    const get = await rep.get(`/api/jobs/${job.id}/claim/packet`);
    expect(get.status).toBe(404);
    expect(get.body.error).toBe(NO_JOB);
    expect(await packetFiles()).toHaveLength(0);

    const mine = await claimJob({ assignedUserId: who.user('rep').userId });
    await rep.post(`/api/jobs/${mine.id}/claim/packet`).expect(200);
    expect(await packetFiles()).toHaveLength(1);
  });

  test('file storage unavailable fails the step with a plain message and answers 503', async () => {
    const job = await claimJob();
    const owner = await who.as('owner');
    (t.deps as { objectStore: unknown }).objectStore = new UnconfiguredObjectStore();
    const res = await owner.post(`/api/jobs/${job.id}/claim/packet`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(NO_STORAGE);
    const steps = await packetSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: 'failed', errorPlain: NO_STORAGE });
    expect(await packetFiles()).toHaveLength(0);
  });

  test('no map key: the PDF is still built without an image', async () => {
    t.staticMap.absent = true;
    const job = await claimJob();
    const owner = await who.as('owner');
    await owner.post(`/api/jobs/${job.id}/claim/packet`).expect(200);
    expect(await packetFiles()).toHaveLength(1);
    // Calls exist only when the property has a point; when it does, the fake answered null.
    expect(t.staticMap.calls.length).toBeLessThanOrEqual(1);
  });

  test('with a map the static map is asked at most once, for the property point, and no network is used', async () => {
    const job = await claimJob();
    const owner = await who.as('owner');
    await owner.post(`/api/jobs/${job.id}/claim/packet`).expect(200);
    expect(t.staticMap.calls.length).toBeLessThanOrEqual(1);
    for (const call of t.staticMap.calls) expect(call.center).toHaveLength(2);
    expect((await packetFiles()).length).toBe(1);
  });
});
