import { beforeEach, describe, expect, test } from 'vitest';
import { agentTasks } from '@roofline/db';
import { seedDemoTask, slugFromArgs, USAGE } from '../src/scripts/seed-demo.ts';
import { dbAudit, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps, dbTask } from './task-helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

describe('the demo seed', () => {
  test('makes the 3-step F2 demo plan for the company with that slug: a draft with a 48-hour window', async () => {
    const out = await seedDemoTask(t.deps.pools, 'acme-roofing', NOW);
    expect(out.companyName).toBe('Acme Roofing');

    expect(await dbTask(t, 'a', out.taskId)).toMatchObject({
      agent: 'storm_scout',
      status: 'draft',
      mode: 'needs_approval',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 48 * HOUR),
    });
    const steps = await dbSteps(t, 'a', out.taskId);
    expect(steps.map((s) => [s.type, s.approvalClass, s.payload, s.status])).toEqual([
      ['demo_message', 'message', { label: 'Text 31 customers' }, 'pending'],
      ['demo_noop', 'internal', { label: 'Door-knock routes for 4 reps' }, 'pending'],
      ['demo_spend', 'spend', { label: 'Google + Facebook ads on the swath', maxSpendCents: 27000 }, 'pending'],
    ]);
    // Made the way an agent makes one: through createTask, audited with no person behind it.
    expect((await dbAudit(t, t.seed.a.companyId, 'task.create'))[0]).toMatchObject({ actorUserId: null, targetId: out.taskId });
    // Only that company has it.
    expect(await inCompany(t, t.seed.b.companyId, (tx) => tx.select().from(agentTasks))).toEqual([]);
  });

  test('an unknown slug is refused in plain words, and nothing is made', async () => {
    await expect(seedDemoTask(t.deps.pools, 'nope-roofing', NOW)).rejects.toThrow('No company has the slug "nope-roofing".');
    expect(await inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(agentTasks))).toEqual([]);
  });

  test('the command line takes --company <slug> or --company=<slug>; anything else is the usage line', () => {
    expect(slugFromArgs(['--company', 'acme-roofing'])).toBe('acme-roofing');
    expect(slugFromArgs(['--company=bolt-roofing'])).toBe('bolt-roofing');
    expect(slugFromArgs(['--company', ' Acme-Roofing '])).toBe('acme-roofing');
    for (const bad of [[], ['--company'], ['--company', ''], ['acme-roofing'], ['--company', '--other']]) {
      expect(() => slugFromArgs(bad), JSON.stringify(bad)).toThrow(USAGE);
    }
    expect(USAGE).toBe('Usage: npm run seed:demo -w @roofline/api -- --company <slug>');
  });
});
