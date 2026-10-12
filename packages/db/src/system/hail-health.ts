import { sql } from 'drizzle-orm';
import type { Db } from '../pools.ts';

/** The newest `valid_at` among hail_runs rows with status 'processed', or null when there is none. app_system needs SELECT on hail_runs (Ruling AW, 0018). */
export async function newestProcessedRunAt(sys: Db): Promise<Date | null> {
  const result = await sys.execute(sql`select max(valid_at) as newest from hail_runs where status = 'processed'`);
  const value = (result.rows[0] as { newest: Date | string | null } | undefined)?.newest;
  return value === null || value === undefined ? null : new Date(value);
}
