import { beforeEach, describe, expect, test } from 'vitest';
import { messages } from '@roofline/db';
import type { TimelinePage, TimelineItem } from '@roofline/shared';
import { Actors, addressFor, inCompany, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const MINUTE = 60 * 1000;

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

const A = () => t.seed.a.companyId;
const repId = () => who.user('rep').userId;
const otherRepId = () => who.user('otherRep').userId;

/** Each write happens at its own instant, so the order of the timeline is not a tie. */
const tick = () => t.clock.advance(MINUTE);

async function customerTimeline(agent: Awaited<ReturnType<Actors['as']>>, customerId: string) {
  return agent.get(`/api/timeline?customerId=${customerId}`);
}

/** Inserts an inbound text for a customer, at the app clock's instant, the way the Twilio hook does. */
async function inboundText(customerId: string, body: string): Promise<void> {
  await inCompany(t, A(), (tx) =>
    tx.insert(messages).values({
      companyId: A(),
      customerId,
      channel: 'sms',
      direction: 'in',
      purpose: null,
      status: 'received',
      body,
      fromE164: '+14025550144',
      toE164: '+14025550199',
      stepId: null,
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    }),
  );
}

describe('the timeline', () => {
  test('a stage move, a note and an inbound text appear newest first', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
    const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(10) });
    const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });

    tick();
    expect((await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'proposal' })).status).toBe(200);
    tick();
    const note = await owner.post('/api/notes').send({ subjectType: 'customer', subjectId: customer.id, body: 'Wants metal roof' });
    expect(note.status).toBe(201);
    tick();
    await inboundText(customer.id, 'Can you come Tuesday?');

    const res = await customerTimeline(owner, customer.id);
    expect(res.status).toBe(200);
    const page = res.body as TimelinePage;
    const at = page.items.map((i) => Date.parse(i.at));
    expect(at).toEqual([...at].sort((a, b) => b - a));

    const [first, second, third] = page.items as TimelineItem[];
    expect(first).toMatchObject({ type: 'text', text: { direction: 'in', body: 'Can you come Tuesday?' } });
    expect(second).toMatchObject({ type: 'activity', kind: 'note', summary: 'Wants metal roof' });
    expect(third).toMatchObject({ type: 'activity', kind: 'job.stage_changed' });
    expect(page.items.some((i) => i.kind === 'note' && i.summary === 'Wants metal roof')).toBe(true);
  });

  test('items written at the same instant are never skipped across pages', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Same Instant' });
    tick();
    // Three notes at one clock instant: a page boundary falls inside the tie.
    for (let i = 1; i <= 3; i++) {
      expect((await owner.post('/api/notes').send({ subjectType: 'customer', subjectId: customer.id, body: `Tie ${i}` })).status).toBe(201);
    }
    const all = (await owner.get(`/api/timeline?customerId=${customer.id}&limit=100`)).body as TimelinePage;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/timeline?customerId=${customer.id}&limit=2${cursor === null ? '' : `&before=${encodeURIComponent(cursor)}`}`;
      const page = (await owner.get(url)).body as TimelinePage;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextBefore;
    } while (cursor !== null);
    expect(seen).toEqual(all.items.map((i) => i.id));
  });

  test('pages with before: no overlap, a string cursor, and the last page has none', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Paging Customer' });
    for (let i = 1; i <= 4; i++) {
      tick();
      expect((await owner.post('/api/notes').send({ subjectType: 'customer', subjectId: customer.id, body: `Note ${i}` })).status).toBe(201);
    }

    const first = (await owner.get(`/api/timeline?customerId=${customer.id}&limit=2`)).body as TimelinePage;
    expect(first.items).toHaveLength(2);
    expect(typeof first.nextBefore).toBe('string');

    const second = (await owner.get(`/api/timeline?customerId=${customer.id}&limit=2&before=${encodeURIComponent(first.nextBefore!)}`))
      .body as TimelinePage;
    expect(second.items.length).toBeGreaterThan(0);
    const firstIds = new Set(first.items.map((i) => i.id));
    for (const item of second.items) expect(firstIds.has(item.id)).toBe(false);
    const oldestFirst = Date.parse(first.items[first.items.length - 1]!.at);
    for (const item of second.items) expect(Date.parse(item.at)).toBeLessThan(oldestFirst);

    // Walk to the end: every item is seen once, and the last page has no cursor.
    const seen: string[] = [...first.items, ...second.items].map((i) => i.id);
    let cursor: string | null = second.nextBefore;
    while (cursor !== null) {
      const page = (await owner.get(`/api/timeline?customerId=${customer.id}&limit=2&before=${encodeURIComponent(cursor)}`))
        .body as TimelinePage;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextBefore;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(4);

    const last = (await owner.get(`/api/timeline?customerId=${customer.id}&limit=100`)).body as TimelinePage;
    expect(last.nextBefore).toBeNull();
  });

  test('a rep does not see activities of a job they cannot see on a shared customer', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Shared Timeline' });
    const houseA = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(11) });
    const houseB = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(12) });
    const visible = await mustCreate(owner, '/api/jobs', {
      customerId: customer.id,
      propertyId: houseA.id,
      stage: 'inspection',
      assignedUserId: repId(),
    });
    const hidden = await mustCreate(owner, '/api/jobs', {
      customerId: customer.id,
      propertyId: houseB.id,
      stage: 'inspection',
      assignedUserId: otherRepId(),
    });
    tick();
    expect((await owner.patch(`/api/jobs/${hidden.id}`).send({ stage: 'proposal' })).status).toBe(200);

    const ownerPage = (await customerTimeline(owner, customer.id)).body as TimelinePage;
    expect(ownerPage.items.map((i) => i.subject.id)).toContain(hidden.id);

    const repRes = await customerTimeline(rep, customer.id);
    expect(repRes.status).toBe(200);
    const repPage = repRes.body as TimelinePage;
    expect(repPage.items.map((i) => i.subject.id)).toContain(visible.id);
    expect(repPage.items.map((i) => i.subject.id)).not.toContain(hidden.id);

    const hiddenJob = await rep.get(`/api/timeline?jobId=${hidden.id}`);
    expect(hiddenJob.status).toBe(404);
    expect(hiddenJob.body).toEqual({ error: NOT_FOUND });
  });

  test('needs exactly one of customerId and jobId', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Either Or' });
    const neither = await owner.get('/api/timeline');
    expect(neither.status).toBe(400);
    const both = await owner.get(`/api/timeline?customerId=${customer.id}&jobId=${NO_UUID}`);
    expect(both.status).toBe(400);
  });

  test('company B gets 404', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Acme Timeline' });
    const res = await customerTimeline(await who.as('owner', 'b'), customer.id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });
});
