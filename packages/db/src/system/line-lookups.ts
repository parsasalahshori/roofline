import { eq } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { lineLookups } from '../schema/index.ts';

/*
 * The cache of Twilio line-type lookups on the app_system pool (D1 Task 13). The table is global:
 * a number's line type does not depend on the company.
 */

/** A cached line type is trusted for this many days. */
export const LINE_LOOKUP_TTL_DAYS = 90;

export type CachedLineType = 'mobile' | 'landline' | 'voip' | 'unknown';

const TTL_MS = LINE_LOOKUP_TTL_DAYS * 24 * 60 * 60 * 1000;

/** The cached line type of a number; null when none is saved or it was looked up over 90 days before `now`. */
export async function cachedLineType(system: Db, e164: string, now: Date): Promise<CachedLineType | null> {
  const [row] = await system
    .select({ lineType: lineLookups.lineType, lookedUpAt: lineLookups.lookedUpAt })
    .from(lineLookups)
    .where(eq(lineLookups.e164, e164))
    .limit(1);
  if (!row || now.getTime() - row.lookedUpAt.getTime() > TTL_MS) return null;
  const t = row.lineType;
  return t === 'mobile' || t === 'landline' || t === 'voip' || t === 'unknown' ? t : null;
}

/** Saves (or refreshes) a number's line type, stamped `now`. */
export async function saveLineType(system: Db, e164: string, lineType: string, now: Date): Promise<void> {
  await system
    .insert(lineLookups)
    .values({ e164, lineType, lookedUpAt: now })
    .onConflictDoUpdate({ target: lineLookups.e164, set: { lineType, lookedUpAt: now } });
}
