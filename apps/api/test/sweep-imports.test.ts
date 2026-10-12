import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { imports } from '@roofline/db';
import { consentAttestationText } from '@roofline/shared';
import { sweepImports } from '../src/jobs/scheduler/sweep-imports.ts';
import { inCompany } from './crm-helpers.ts';
import { buildImportFixture } from './fixtures/import-1000.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const FIXTURE = buildImportFixture();
let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

async function uploadImport(owner: SuperAgent): Promise<string> {
  const res = await owner
    .post(`/api/imports?fileName=customers.csv`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from(FIXTURE.csv));
  return res.body.id as string;
}

const startBody = () => ({ consentAttested: true, consentText: consentAttestationText(t.seed.a.name) });

/** Uploads and starts an import while the queue is down: it is committed as queued, with no job waiting. */
async function strandedQueued(): Promise<{ owner: SuperAgent; id: string }> {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const id = await uploadImport(owner);
  vi.spyOn(t.jobs, 'send').mockRejectedValueOnce(new Error('queue down'));
  const res = await owner.post(`/api/imports/${id}/start`).send(startBody());
  expect(res.status).toBe(202);
  expect(res.body.status).toBe('queued');
  return { owner, id };
}

const importJobs = () => t.jobs.sent.filter((s) => s.name === 'import-customers');

describe('import sweep', () => {
  test('start answers 202 queued when the queue is down', async () => {
    const { owner, id } = await strandedQueued();
    const after = await owner.get(`/api/imports/${id}`);
    expect(after.body.status).toBe('queued');
  });

  test('retry answers 202 queued when the queue is down', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const id = await uploadImport(owner);
    await owner.post(`/api/imports/${id}/start`).send(startBody());
    await inCompany(t, t.seed.a.companyId, (tx) =>
      tx.update(imports).set({ status: 'failed', errorPlain: 'Something went wrong.' }).where(eq(imports.id, id)),
    );
    vi.spyOn(t.jobs, 'send').mockRejectedValueOnce(new Error('queue down'));
    const res = await owner.post(`/api/imports/${id}/retry`).send({});
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    const after = await owner.get(`/api/imports/${id}`);
    expect(after.body.status).toBe('queued');
  });

  test('a stranded queued import is re-sent after 2 minutes and then runs', async () => {
    const { owner, id } = await strandedQueued();
    t.clock.advance(3 * 60 * 1000);
    expect(await sweepImports(t.deps, t.clock.now())).toEqual({ resent: 1 });
    const sent = importJobs();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ data: { companyId: t.seed.a.companyId, importId: id }, singletonKey: id });
    await t.jobs.drain(t.deps);
    const after = await owner.get(`/api/imports/${id}`);
    expect(after.body.status).toBe('done');
  });

  test('a queued import 30 seconds old is not re-sent', async () => {
    await strandedQueued();
    t.clock.advance(30 * 1000);
    expect(await sweepImports(t.deps, t.clock.now())).toEqual({ resent: 0 });
  });

  test('a processing import is re-sent only after 30 minutes without progress', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const id = await uploadImport(owner);
    await inCompany(t, t.seed.a.companyId, (tx) =>
      tx.update(imports).set({ status: 'processing', updatedAt: t.clock.now() }).where(eq(imports.id, id)),
    );
    t.clock.advance(60 * 1000);
    expect(await sweepImports(t.deps, t.clock.now())).toEqual({ resent: 0 });
    t.clock.advance(30 * 60 * 1000);
    expect(await sweepImports(t.deps, t.clock.now())).toEqual({ resent: 1 });
  });
});
