import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTasks } from '@roofline/db';
import {
  parseSeedArgs,
  PRODUCTION_REFUSAL,
  refuseInProduction,
  seedDemoTask,
  SeedError,
  slugFromArgs,
  USAGE,
} from '../src/scripts/seed-demo.ts';
import { demoTask } from '../src/tasks/demo.ts';
import { dbAudit, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps, dbTask } from './task-helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;
/** The demo text's sample for Acme Roofing: the company name is the only part that changes between companies. */
const ACME_SAMPLE =
  "Hi Maria, it's Acme Roofing. Tuesday's hail hit your street. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.";

describe('the demo plan itself', () => {
  test('without a company name the sample says "your roofer"', () => {
    expect(demoTask(NOW).steps[0]?.payload).toMatchObject({ sample: expect.stringContaining("it's your roofer.") });
  });
});

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
      [
        'demo_message',
        'message',
        {
          label: 'Text 31 customers',
          sample: ACME_SAMPLE,
          recipientCount: 31,
          sendTime: 'today at 10:00 AM',
        },
        'pending',
      ],
      ['demo_noop', 'internal', { label: 'Door-knock routes for 4 reps' }, 'pending'],
      [
        'demo_spend',
        'spend',
        { label: 'Google + Facebook ads on the swath', maxSpendCents: 27000, area: 'North side swath · 4.2 sq mi' },
        'pending',
      ],
    ]);
    // Made the way an agent makes one: through createTask, audited with no person behind it.
    expect((await dbAudit(t, t.seed.a.companyId, 'task.create'))[0]).toMatchObject({ actorUserId: null, targetId: out.taskId });
    // Only that company has it.
    expect(await inCompany(t, t.seed.b.companyId, (tx) => tx.select().from(agentTasks))).toEqual([]);
  });

  test('the stored previews show the sample text, the count and the send time, and the area under the spend line', async () => {
    const out = await seedDemoTask(t.deps.pools, 'acme-roofing', NOW);
    const steps = await dbSteps(t, 'a', out.taskId);
    expect(steps[0]!.preview).toMatchObject({
      title: 'Text 31 customers',
      messageSample: ACME_SAMPLE,
      recipientCount: 31,
      sendTime: 'today at 10:00 AM',
    });
    expect(steps[2]!.preview).toMatchObject({
      title: 'Google + Facebook ads on the swath',
      lines: ['Spends up to $270.00', 'North side swath · 4.2 sq mi'],
    });
  });

  test('the sample text names the company the plan is made for', async () => {
    const out = await seedDemoTask(t.deps.pools, 'bolt-roofing', NOW);
    const [message] = await dbSteps(t, 'b', out.taskId);
    expect(message!.payload).toMatchObject({ sample: expect.stringContaining("it's Bolt Roofing.") });
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

describe('the production guard', () => {
  const REFUSAL = 'Refusing to seed demo data in production. Pass --allow-production if you really mean it.';

  test('the refusal says what to do', () => {
    expect(PRODUCTION_REFUSAL).toBe(REFUSAL);
  });

  test('NODE_ENV=production is refused as a SeedError unless the flag was passed', () => {
    expect(() => refuseInProduction({ NODE_ENV: 'production' }, false)).toThrow(SeedError);
    expect(() => refuseInProduction({ NODE_ENV: 'production' }, false)).toThrow(REFUSAL);
    expect(() => refuseInProduction({ NODE_ENV: 'production' }, true)).not.toThrow();
  });

  test('any other environment (or none) is left alone', () => {
    for (const NODE_ENV of ['development', 'test', 'staging', '', undefined]) {
      expect(() => refuseInProduction({ NODE_ENV }, false), String(NODE_ENV)).not.toThrow();
    }
  });

  test('--allow-production can come anywhere on the command line, and only that exact flag counts', () => {
    expect(parseSeedArgs(['--company', 'acme-roofing'])).toEqual({ slug: 'acme-roofing', allowProduction: false });
    expect(parseSeedArgs(['--company', 'acme-roofing', '--allow-production'])).toEqual({ slug: 'acme-roofing', allowProduction: true });
    expect(parseSeedArgs(['--allow-production', '--company=acme-roofing'])).toEqual({ slug: 'acme-roofing', allowProduction: true });
    for (const bad of [['--allow-production'], ['--company', 'acme-roofing', '--allow-prod'], ['--company', '--allow-production']]) {
      expect(() => parseSeedArgs(bad), JSON.stringify(bad)).toThrow(USAGE);
    }
  });

  // The real script, run the way `npm run seed:demo` runs it. No database URLs are set, so a run
  // that gets past the guard stops at the "Set DATABASE_URL_TENANT..." line and touches nothing.
  describe('the script itself', () => {
    const API_DIR = fileURLToPath(new URL('..', import.meta.url));
    const NEEDS_URLS = 'Set DATABASE_URL_TENANT and DATABASE_URL_SYSTEM';

    async function runSeed(nodeEnv: string | undefined, ...args: string[]) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.DATABASE_URL_TENANT;
      delete env.DATABASE_URL_SYSTEM;
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/scripts/seed-demo.ts', ...args], { cwd: API_DIR, env });
        return { code: 0, stdout, stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    }

    test('in production it refuses, says why, and exits non-zero, before it looks at the database URLs', async () => {
      const out = await runSeed('production', '--company', 'acme-roofing');
      expect(out.code).not.toBe(0);
      expect(out.stderr.trim()).toBe(REFUSAL);
      expect(out.stdout).toBe('');
    });

    test('with --allow-production it gets past the guard (and then stops for the missing database URLs)', async () => {
      const out = await runSeed('production', '--company', 'acme-roofing', '--allow-production');
      expect(out.code).not.toBe(0);
      expect(out.stderr).not.toContain('Refusing');
      expect(out.stderr).toContain(NEEDS_URLS);
    });

    test('outside production there is no guard', async () => {
      for (const nodeEnv of ['development', undefined]) {
        const out = await runSeed(nodeEnv, '--company', 'acme-roofing');
        expect(out.stderr, String(nodeEnv)).not.toContain('Refusing');
        expect(out.stderr, String(nodeEnv)).toContain(NEEDS_URLS);
      }
    });
  });
});
