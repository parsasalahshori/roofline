import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { companyStorms, storms, stormPages } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/** 8 characters of RFC 4648 base32 lowercase (a-z, 2-7). */
export const STORM_PAGE_CODE_LENGTH = 8;

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** Tries before giving up on finding a free code (a collision in 32^8 codes is very unlikely). */
const CODE_ATTEMPTS = 5;
/** A page stays live this many days after the storm's convective day. */
const ACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A new page code: 8 characters from the base32 alphabet. Each random byte keeps its low five bits,
 * which map onto the 32 letters exactly (256 is a multiple of 32), so no letter is favoured.
 * `random` is injectable for tests.
 */
export function newStormPageCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(STORM_PAGE_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < STORM_PAGE_CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i]! & 31];
  }
  return code;
}

/**
 * The company's landing page for one storm, created on first use. Existing pages are returned as
 * they are: their code and `activeUntil` never change.
 *
 * `activeUntil` is the storm's convective day plus 30 days, as an exclusive end at midnight UTC.
 * The convective day is already a calendar date in `storms.convective_day` (the SPC day the storm
 * is counted under), so it is used as written: no time-zone conversion, and every company sees the
 * same end for the same storm.
 *
 * An advisory lock on the company and storm serializes two concurrent first calls, so one storm
 * never gets two pages. The code is retried on a clash with an existing page code (any company).
 * Runs inside `withTenant`.
 */
export async function ensureStormPage(
  tx: Tx,
  ctx: TenantContext,
  input: { companyStormId: string; now: Date },
): Promise<{ id: string; code: string; activeUntil: Date; created: boolean }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${ctx.companyId}::text || ':storm-page:' || ${input.companyStormId}::text, 0))`,
  );

  const [existing] = await tx
    .select({ id: stormPages.id, code: stormPages.code, activeUntil: stormPages.activeUntil })
    .from(stormPages)
    .where(and(eq(stormPages.companyId, ctx.companyId), eq(stormPages.companyStormId, input.companyStormId)))
    .limit(1);
  if (existing) return { ...existing, created: false };

  const day = await convectiveDayOf(tx, ctx, input.companyStormId);
  const activeUntil = new Date(Date.parse(`${day}T00:00:00Z`) + ACTIVE_DAYS * DAY_MS);

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    // `on conflict do nothing` skips a code that is already taken (by any company: the unique key is
    // global), so a clash returns no row and the loop draws another code.
    const [row] = await tx
      .insert(stormPages)
      .values({
        companyId: ctx.companyId,
        companyStormId: input.companyStormId,
        code: newStormPageCode(),
        activeUntil,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: stormPages.code })
      .returning({ id: stormPages.id, code: stormPages.code });
    if (row) return { id: row.id, code: row.code, activeUntil, created: true };
  }
  throw new Error('ensureStormPage: could not find a free page code');
}

/** The storm's convective day (YYYY-MM-DD) for one of the company's storm rows. Throws when the company has no such row. */
async function convectiveDayOf(tx: Tx, ctx: TenantContext, companyStormId: string): Promise<string> {
  const [row] = await tx
    .select({ day: storms.convectiveDay })
    .from(companyStorms)
    .innerJoin(storms, eq(storms.id, companyStorms.stormId))
    .where(and(eq(companyStorms.id, companyStormId), eq(companyStorms.companyId, ctx.companyId)))
    .limit(1);
  if (!row) throw new Error('ensureStormPage: that storm is not on this company');
  return row.day;
}
