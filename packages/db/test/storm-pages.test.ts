import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { upsertCompanyStorm } from '../src/repos/company-storms.ts';
import { ensureStormPage, extendStormPageUntil, newStormPageCode, STORM_PAGE_CODE_LENGTH } from '../src/repos/storm-pages.ts';
import { createPools, type Pools } from '../src/pools.ts';
import { type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { insertOmahaStorm, type Query } from './fixtures/storms.ts';

const urls = inject('dbUrls');

let owner: pg.Pool;
let pools: Pools;
let seed: { a: SeededCompany; b: SeededCompany };

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pools, { companyId, userId: null, role: 'system', canApproveSpend: false }, fn);

const DAY = '2026-05-01';
const NOW = new Date('2026-05-02T12:00:00Z');
const CODE_SHAPE = /^[a-z2-7]{8}$/;

/** Upserts the company's row for one storm and returns its company_storms id. */
async function companyStormFor(companyId: string, stormId: string): Promise<string> {
  return asCompany(companyId, async (tx) => {
    const { companyStorm } = await upsertCompanyStorm(tx, { stormId, maxIn: 1.5, customersHit: 0, homesHit: 0, now: NOW });
    return companyStorm.id;
  });
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: urls.owner });
  pools = createPools({ tenant: urls.tenant, system: urls.system });
});

afterAll(async () => {
  await pools?.end();
  await owner?.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('newStormPageCode', () => {
  test('has the documented length', () => {
    expect(STORM_PAGE_CODE_LENGTH).toBe(8);
  });

  test('returns 8 lowercase base32 characters', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newStormPageCode()).toMatch(CODE_SHAPE);
    }
  });

  test('maps each byte to the alphabet with no bias for the low five bits', () => {
    const bytes = Buffer.from([0, 25, 26, 31, 32, 33, 64, 255]);
    expect(newStormPageCode(() => bytes)).toBe('az27aba7');
  });

  test('asks for exactly 8 random bytes', () => {
    let requested = -1;
    newStormPageCode((n) => {
      requested = n;
      return Buffer.alloc(n);
    });
    expect(requested).toBe(8);
  });
});

describe('ensureStormPage', () => {
  test('creates the page once and returns the same code on the second call', async () => {
    const companyStormId = await companyStormFor(seed.a.companyId, await insertOmahaStorm(q, DAY));

    const first = await asCompany(seed.a.companyId, (tx) => ensureStormPage(tx, ctxOf(seed.a), { companyStormId, now: NOW }));
    expect(first.created).toBe(true);
    expect(first.code).toMatch(CODE_SHAPE);

    const second = await asCompany(seed.a.companyId, (tx) =>
      ensureStormPage(tx, ctxOf(seed.a), { companyStormId, now: new Date('2026-06-01T00:00:00Z') }),
    );
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.code).toBe(first.code);
    expect(second.activeUntil.toISOString()).toBe(first.activeUntil.toISOString());

    const rows = await q(`select id from storm_pages where company_id = $1`, [seed.a.companyId]);
    expect(rows).toHaveLength(1);
  });

  test('active_until is the storm day plus 30 days, as midnight UTC', async () => {
    const companyStormId = await companyStormFor(seed.a.companyId, await insertOmahaStorm(q, DAY));
    const page = await asCompany(seed.a.companyId, (tx) => ensureStormPage(tx, ctxOf(seed.a), { companyStormId, now: NOW }));
    expect(page.activeUntil.toISOString()).toBe('2026-05-31T00:00:00.000Z');

    const stored = await q(`select active_until from storm_pages where id = $1`, [page.id]);
    expect(new Date(stored[0]!.active_until as Date).toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  test('company B cannot see company A page (RLS)', async () => {
    const companyStormId = await companyStormFor(seed.a.companyId, await insertOmahaStorm(q, DAY));
    const page = await asCompany(seed.a.companyId, (tx) => ensureStormPage(tx, ctxOf(seed.a), { companyStormId, now: NOW }));

    const seenByB = await asCompany(seed.b.companyId, async (tx) => {
      const result = await tx.execute(sql`select id from storm_pages where id = ${page.id}::uuid`);
      return result.rows;
    });
    expect(seenByB).toHaveLength(0);
  });

  test('company B gets its own page for the same storm, and codes are unique across companies', async () => {
    const stormId = await insertOmahaStorm(q, DAY);
    const stormA = await companyStormFor(seed.a.companyId, stormId);
    const stormB = await companyStormFor(seed.b.companyId, stormId);

    const pageA = await asCompany(seed.a.companyId, (tx) => ensureStormPage(tx, ctxOf(seed.a), { companyStormId: stormA, now: NOW }));
    const pageB = await asCompany(seed.b.companyId, (tx) => ensureStormPage(tx, ctxOf(seed.b), { companyStormId: stormB, now: NOW }));

    expect(pageB.created).toBe(true);
    expect(pageB.id).not.toBe(pageA.id);
    expect(pageB.code).not.toBe(pageA.code);
  });
});

function ctxOf(company: SeededCompany) {
  return { companyId: company.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
}

describe('extendStormPageUntil', () => {
  test('extends a page, never shortens it, and is tenant-scoped', async () => {
    const stormId = await insertOmahaStorm(q, DAY);
    const csId = await companyStormFor(seed.a.companyId, stormId);
    const page = await asCompany(seed.a.companyId, (tx) => ensureStormPage(tx, { companyId: seed.a.companyId, userId: null, role: 'system', canApproveSpend: false }, { companyStormId: csId, now: NOW }));
    const ctx = { companyId: seed.a.companyId, userId: null, role: 'system', canApproveSpend: false } as const;

    const later = new Date(page.activeUntil.getTime() + 10 * 86_400_000);
    expect((await asCompany(seed.a.companyId, (tx) => extendStormPageUntil(tx, ctx, page.id, later)))?.getTime()).toBe(later.getTime());

    const earlier = new Date(page.activeUntil.getTime() - 5 * 86_400_000);
    expect((await asCompany(seed.a.companyId, (tx) => extendStormPageUntil(tx, ctx, page.id, earlier)))?.getTime()).toBe(later.getTime());

    // Another company cannot touch it.
    const other = { ...ctx, companyId: seed.b.companyId };
    expect(await asCompany(seed.b.companyId, (tx) => extendStormPageUntil(tx, other, page.id, new Date(later.getTime() + 86_400_000)))).toBeNull();
  });
});
