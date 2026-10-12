import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { createCustomer, createJob, createProperty, jobs, type TenantContext } from '@roofline/db';
import type { BoardColumn, BoardView, JobCard } from '@roofline/shared';
import { seedShowcase } from '../src/scripts/showcase.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-12T15:00:00.000Z');

/** The open stages of the board, in column order, and what the showcase puts in each. */
const BOARD_STAGES = ['lead', 'inspection', 'proposal', 'won', 'installed'] as const;
const SHOWCASE_COUNTS: Record<(typeof BOARD_STAGES)[number], number> = {
  lead: 8,
  inspection: 7,
  proposal: 6,
  won: 4,
  installed: 2,
};

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;

/** Seeds Acme's showcase at the clock's time (every stage_changed_at is that time). */
async function seeded(): Promise<void> {
  await seedShowcase(t.deps.pools, A(), t.clock.now(), { companyName: 'Acme Roofing' });
}

/** GET /api/jobs/board with the given query. */
async function boardFor(agent: SuperAgent, query: Record<string, string | number> = {}): Promise<BoardView> {
  const res = await agent.get('/api/jobs/board').query(query);
  expect(res.status).toBe(200);
  return res.body as BoardView;
}

const column = (board: BoardView, stage: string): BoardColumn => {
  const found = board.columns.find((c) => c.stage === stage);
  if (!found) throw new Error(`no ${stage} column`);
  return found;
};

const cardsOf = (board: BoardView): JobCard[] => board.columns.flatMap((c) => c.jobs);
const countOf = (board: BoardView): number => board.columns.reduce((sum, c) => sum + c.count, 0);

/** Adds `n` leads (a customer, a house and a lead each) straight into the database, in one transaction. */
async function addLeads(n: number): Promise<void> {
  const ctx: TenantContext = { companyId: A(), userId: null, role: 'system', canApproveSpend: false };
  await inCompany(t, A(), async (tx) => {
    for (let i = 0; i < n; i += 1) {
      const customer = await createCustomer(tx, ctx, { displayName: `Paging Test ${i}` }, { now: t.clock.now() });
      const property = await createProperty(
        tx,
        ctx,
        { customerId: customer.id, addressLine: `${900 + i} Paging Ln`, city: 'Omaha', state: 'NE', zip: '68102' },
        { now: t.clock.now() },
      );
      await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id }, { now: t.clock.now() });
    }
  });
}

describe('the pipeline board', () => {
  test('the showcase jobs land in their columns with counts', async () => {
    await seeded();
    const board = await boardFor(await who.as('owner'));

    expect(board.columns.map((c) => c.stage)).toEqual([...BOARD_STAGES]);
    for (const stage of BOARD_STAGES) {
      expect(column(board, stage).count, stage).toBe(SHOWCASE_COUNTS[stage]);
    }
    expect(board.lost.count).toBe(1);
    for (const c of board.columns) {
      expect(c.jobs.length, c.stage).toBe(c.count);
    }
  });

  test('totals for owner and office, none for reps', async () => {
    await seeded();
    for (const member of ['owner', 'office'] as const) {
      const board = await boardFor(await who.as(member));
      for (const c of board.columns) {
        expect(typeof c.totalCents, `${member} ${c.stage}`).toBe('number');
        const sum = c.jobs.reduce((total, job) => total + (job.valueCents ?? 0), 0);
        expect(c.totalCents, `${member} ${c.stage}`).toBe(sum);
      }
      expect(column(board, 'won').totalCents).toBeGreaterThan(0);
    }

    const rep = await boardFor(await who.as('rep'));
    for (const c of rep.columns) {
      expect(c.totalCents, c.stage).toBeNull();
    }
  });

  test('a rep sees their jobs and unassigned leads only', async () => {
    await seeded();
    const owner = await who.as('owner');
    const repId = who.user('rep').userId;

    // Give the rep one proposal, so there is a card that is assigned to them.
    const proposal = column(await boardFor(owner), 'proposal').jobs[0]!;
    const assigned = await owner.patch(`/api/jobs/${proposal.id}`).send({ assignedUserId: repId });
    expect(assigned.status).toBe(200);

    const everything = await boardFor(owner);
    const rep = await boardFor(await who.as('rep'));
    expect(countOf(rep)).toBeLessThan(countOf(everything));
    expect(cardsOf(rep)).toContainEqual(expect.objectContaining({ id: proposal.id }));

    for (const card of cardsOf(rep)) {
      if (card.assigned?.userId === repId) continue;
      expect(card.stage, card.id).toBe('lead');
      expect(card.assigned, card.id).toBeNull();
      expect(card.valueCents, card.id).toBeNull();
    }
  });

  test('installed jobs older than 30 days leave the board', async () => {
    await seeded();
    const owner = await who.as('owner');
    expect(column(await boardFor(owner), 'installed').count).toBe(2);

    const [kept] = await inCompany(t, A(), (tx) =>
      tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.stage, 'installed')),
    );
    t.clock.advance(31 * DAY_MS);
    // Sessions last 30 days, so the owner signs in again at the new time.
    who = new Actors(t);
    const later = await who.as('owner');
    expect(column(await boardFor(later), 'installed').count).toBe(0);

    // A job that moved to Installed 29 days before the clock stays on the board.
    const recent = new Date(t.clock.now().getTime() - 29 * DAY_MS);
    await inCompany(t, A(), (tx) =>
      tx.update(jobs).set({ stageChangedAt: recent }).where(eq(jobs.id, kept!.id)),
    );
    const installed = column(await boardFor(later), 'installed');
    expect(installed.count).toBe(1);
    expect(installed.jobs.map((j) => j.id)).toEqual([kept!.id]);
  });

  test('paging a column', async () => {
    await seeded();
    await addLeads(60);
    const owner = await who.as('owner');

    const first = column(await boardFor(owner), 'lead');
    expect(first.count).toBe(SHOWCASE_COUNTS.lead + 60);
    expect(first.jobs).toHaveLength(50);

    const res = await owner.get('/api/jobs/board').query({ stage: 'lead', offset: 50 });
    expect(res.status).toBe(200);
    expect(res.body.columns).toBeUndefined();
    const second = res.body as BoardColumn;
    expect(second.stage).toBe('lead');
    expect(second.count).toBe(first.count);
    expect(second.jobs).toHaveLength(first.count - 50);

    const firstIds = new Set(first.jobs.map((j) => j.id));
    for (const card of second.jobs) {
      expect(firstIds.has(card.id), card.id).toBe(false);
    }
  });

  test('filters by assignee, source and text', async () => {
    await seeded();
    const owner = await who.as('owner');
    const ownerId = who.user('owner').userId;
    const officeId = who.user('office').userId;
    const leads = column(await boardFor(owner), 'lead').jobs;
    const mine = leads[0]!;
    const referred = leads[1]!;
    const named = leads[2]!;
    const housed = leads[3]!;

    expect((await owner.patch(`/api/jobs/${mine.id}`).send({ assignedUserId: ownerId })).status).toBe(200);
    expect((await owner.patch(`/api/jobs/${referred.id}`).send({ source: 'referral' })).status).toBe(200);

    const onlyMine = await boardFor(owner, { assigned: 'me' });
    expect(cardsOf(onlyMine).map((j) => j.id)).toEqual([mine.id]);
    for (const card of cardsOf(onlyMine)) {
      expect(card.assigned?.userId).toBe(ownerId);
    }

    const unassigned = await boardFor(owner, { assigned: 'unassigned' });
    expect(cardsOf(unassigned)).toHaveLength(SHOWCASE_COUNTS.lead - 1);
    for (const card of cardsOf(unassigned)) {
      expect(card.assigned, card.id).toBeNull();
    }

    const officeOnly = await boardFor(owner, { assigned: officeId });
    expect(countOf(officeOnly)).toBe(0);
    for (const card of cardsOf(officeOnly)) {
      expect(card.assigned?.userId).toBe(officeId);
    }

    const referrals = await boardFor(owner, { source: 'referral' });
    expect(cardsOf(referrals).map((j) => j.id)).toEqual([referred.id]);

    const manual = await boardFor(owner, { source: 'manual' });
    expect(countOf(manual)).toBe(countOf(await boardFor(owner)) - 1);

    const byName = await boardFor(owner, { q: named.customerName });
    expect(cardsOf(byName).map((j) => j.id)).toContain(named.id);
    expect(countOf(byName)).toBeLessThan(countOf(await boardFor(owner)));

    const byStreet = await boardFor(owner, { q: housed.addressLine });
    expect(cardsOf(byStreet).map((j) => j.id)).toContain(housed.id);
    expect(countOf(byStreet)).toBeLessThan(countOf(await boardFor(owner)));
  });

  test('a bad assigned value is refused with its field', async () => {
    await seeded();
    const res = await (await who.as('owner')).get('/api/jobs/board').query({ assigned: 'someone-random' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: 'assigned', error: expect.any(String) });
  });

  test('stuck cards', async () => {
    await seeded();
    const owner = await who.as('owner');

    const fresh = await boardFor(owner);
    for (const c of fresh.columns) {
      for (const card of c.jobs) expect(card.stuck, `${c.stage} ${card.id}`).toBe(false);
    }

    t.clock.advance(15 * DAY_MS);
    const later = await boardFor(owner);
    let stuckCount = 0;
    for (const c of later.columns) {
      for (const card of c.jobs) {
        if (c.stage === 'won' || c.stage === 'installed') {
          expect(card.stuck, `${c.stage} ${card.id}`).toBe(false);
          continue;
        }
        expect(card.stuck, `${c.stage} ${card.id}`).toBe(true);
        expect(card.daysInStage, `${c.stage} ${card.id}`).toBeGreaterThanOrEqual(15);
        stuckCount += 1;
      }
    }
    expect(stuckCount).toBe(SHOWCASE_COUNTS.lead + SHOWCASE_COUNTS.inspection + SHOWCASE_COUNTS.proposal);
  });

  test("company B's board never shows A's jobs", async () => {
    await seeded();
    const aBoard = await boardFor(await who.as('owner'));
    expect(countOf(aBoard)).toBeGreaterThan(0);
    const aJob = column(aBoard, 'lead').jobs[0]!;

    const bOwner = await who.as('owner', 'b');
    const bBoard = await boardFor(bOwner);
    expect(countOf(bBoard)).toBe(0);
    for (const c of bBoard.columns) {
      expect(c.count, c.stage).toBe(0);
      expect(c.jobs, c.stage).toEqual([]);
    }
    expect(bBoard.lost.count).toBe(0);

    const res = await bOwner.get(`/api/jobs/${aJob.id}/view`);
    expect(res.status).toBe(404);
  });
});
