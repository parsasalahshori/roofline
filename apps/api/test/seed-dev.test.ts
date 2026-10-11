import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import { agentTasks, companies, customers } from '@roofline/db';
import { DEV_ONLY_REFUSAL, reportLines, type SeedDevResult, refuseUnlessDevelopment, seedDev } from '../src/scripts/seed-dev.ts';
import { SeedError } from '../src/scripts/seed-demo.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/** The dev users' shared password: a dev-only test credential, the one the README names. */
const DEV_PASSWORD = 'roofline-demo-2026';
const DEV_EMAILS = ['owner@summit.test', 'office@summit.test', 'rep@summit.test'];

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

describe('the dev seed guard', () => {
  test('refuses every NODE_ENV but development, with the dev-only sentence', () => {
    for (const NODE_ENV of ['production', 'test', 'staging', '', undefined]) {
      expect(() => refuseUnlessDevelopment({ NODE_ENV }), String(NODE_ENV)).toThrow(SeedError);
      expect(() => refuseUnlessDevelopment({ NODE_ENV }), String(NODE_ENV)).toThrow(DEV_ONLY_REFUSAL);
    }
  });

  test('development is allowed', () => {
    expect(() => refuseUnlessDevelopment({ NODE_ENV: 'development' })).not.toThrow();
  });

  // The real script, run the way `npm run seed:dev` runs it. The database URLs are removed from the
  // environment, so a run that gets past the guard stops at the "Set DATABASE_URL_OWNER..." line.
  describe('the script itself', () => {
    const API_DIR = fileURLToPath(new URL('..', import.meta.url));

    async function runSeedDev(nodeEnv: string | undefined) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.DATABASE_URL_OWNER;
      delete env.DATABASE_URL_TENANT;
      delete env.DATABASE_URL_SYSTEM;
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/scripts/seed-dev.ts'], {
          cwd: API_DIR,
          env,
        });
        return { code: 0, stdout, stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    }

    test('in production it refuses, says why, and exits non-zero', async () => {
      const out = await runSeedDev('production');
      expect(out.code).not.toBe(0);
      expect(out.stderr.trim()).toBe(DEV_ONLY_REFUSAL);
      expect(out.stdout).toBe('');
    });

    test('with NODE_ENV unset it refuses the same way', async () => {
      const out = await runSeedDev(undefined);
      expect(out.code).not.toBe(0);
      expect(out.stderr.trim()).toBe(DEV_ONLY_REFUSAL);
      expect(out.stdout).toBe('');
    });

    test('in development without the database URLs it stops and names them', async () => {
      const out = await runSeedDev('development');
      expect(out.code).not.toBe(0);
      expect(out.stderr).toContain('Set DATABASE_URL_OWNER');
    });
  });
});

describe('the dev seed', () => {
  test('on a fresh database it makes Summit Roofing with its three people and the showcase', async () => {
    const result = await seedDev(t.deps.pools, inject('dbUrls').owner, t.clock.now());
    expect(result).toMatchObject({
      created: true,
      name: 'Summit Roofing',
      emails: DEV_EMAILS,
      counts: { customers: 60, properties: 70, jobs: 28 },
    });

    const [company] = await t.deps.pools.system.select().from(companies).where(eq(companies.id, result.companyId));
    expect(company).toMatchObject({ name: 'Summit Roofing', slug: 'summit-roofing', timezone: 'America/Chicago', addressState: 'NE' });

    const members = await inCompany(t, result.companyId, async (tx) =>
      (await tx.execute(sql`select email, name, role, can_approve_spend from company_members order by email`)).rows,
    );
    expect(members).toEqual([
      { email: 'office@summit.test', name: 'Chris Lane', role: 'office', can_approve_spend: false },
      { email: 'owner@summit.test', name: 'Dana Park', role: 'owner', can_approve_spend: false },
      { email: 'rep@summit.test', name: 'Robin Hale', role: 'rep', can_approve_spend: false },
    ]);

    // Each person can sign in through the real route, with the dev password.
    for (const email of DEV_EMAILS) {
      const res = await request(t.app).post('/api/auth/login').send({ email, password: DEV_PASSWORD });
      expect(res.status, email).toBe(200);
    }

    // The owner's approval queue holds the one plan.
    const owner = request.agent(t.app);
    await owner.post('/api/auth/login').send({ email: 'owner@summit.test', password: DEV_PASSWORD }).expect(200);
    const approvals = await owner.get('/api/approvals');
    expect(approvals.status).toBe(200);
    expect(approvals.body.count).toBe(1);

    // Acme and Bolt are untouched by it.
    for (const key of ['a', 'b'] as const) {
      const companyId = t.seed[key].companyId;
      expect(await inCompany(t, companyId, (tx) => tx.select().from(customers))).toEqual([]);
    }
  });

  test('a second run finds the company, reports it, and changes nothing', async () => {
    const urls = inject('dbUrls');
    const first = await seedDev(t.deps.pools, urls.owner, t.clock.now());
    const second = await seedDev(t.deps.pools, urls.owner, t.clock.now());

    expect(second).toMatchObject({ created: false, companyId: first.companyId, name: 'Summit Roofing', emails: DEV_EMAILS });
    expect(second.counts).toBeUndefined();

    expect(await inCompany(t, first.companyId, (tx) => tx.select().from(customers))).toHaveLength(60);
    expect(await inCompany(t, first.companyId, (tx) => tx.select().from(agentTasks))).toHaveLength(1);
    expect(await inCompany(t, first.companyId, (tx) => tx.execute(sql`select 1 from company_members`))).toHaveLength(3);
  });
});

describe('the lines the script prints', () => {
  const created: SeedDevResult = {
    created: true,
    companyId: '11111111-1111-4111-8111-111111111111',
    name: 'Summit Roofing',
    emails: DEV_EMAILS,
    counts: { customers: 60, properties: 70, jobs: 28 },
  };
  const existing: SeedDevResult = { created: false, companyId: created.companyId, name: 'Summit Roofing', emails: DEV_EMAILS };

  test('a created company says what was made and first lists the three sign-in emails', () => {
    const lines = reportLines(created);
    expect(lines[0]).toContain('60 customers');
    expect(lines[0]).toContain('70 addresses');
    expect(lines[0]).toContain('28 jobs');
    expect(lines.join('\n')).toContain(DEV_EMAILS.join('\n  '.trimStart()).split('\n')[0]!);
    for (const email of DEV_EMAILS) expect(lines).toContain(`  ${email}`);
  });

  test('an existing company is reported as unchanged', () => {
    expect(reportLines(existing)[0]).toBe('Summit Roofing already exists, so nothing was changed.');
  });

  test('the password is never printed, for a created or an existing company', () => {
    expect(reportLines(created).join('\n')).not.toContain(DEV_PASSWORD);
    expect(reportLines(existing).join('\n')).not.toContain(DEV_PASSWORD);
  });
});
